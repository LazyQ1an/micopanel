import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import Docker from "dockerode";
import * as tar from "tar";
import type { AgentTask, InstanceSpec, NodeUsage } from "@micopanel/protocol";
import type { S3Config } from "./config.js";

export interface TaskResult {
  message: string;
  data?: Record<string, unknown>;
}

export class DockerRuntime {
  private readonly docker: Docker;
  private readonly consoleStreams = new Map<string, NodeJS.WritableStream>();
  private readonly s3?: S3Client;
  private readonly s3Bucket?: string;

  constructor(
    socketPath: string,
    private readonly dataRoot: string,
    private readonly publishConsole: (instanceId: string, line: string) => void,
    s3Config?: S3Config
  ) {
    this.docker = new Docker({ socketPath });
    if (s3Config) {
      this.s3 = new S3Client({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        forcePathStyle: true,
        credentials: { accessKeyId: s3Config.accessKeyId, secretAccessKey: s3Config.secretAccessKey }
      });
      this.s3Bucket = s3Config.bucket;
    }
  }

  async init(): Promise<void> {
    await mkdir(resolve(this.dataRoot, "instances"), { recursive: true });
    await mkdir(resolve(this.dataRoot, "archives"), { recursive: true });
    await mkdir(resolve(this.dataRoot, "backups"), { recursive: true });
    await this.docker.ping();
  }

  private containerName(instanceId: string): string {
    return `micopanel-${instanceId}`;
  }

  private instancePath(instanceId: string): string {
    return resolve(this.dataRoot, "instances", instanceId);
  }

  private archivePath(instanceId: string): string {
    return resolve(this.dataRoot, "archives", instanceId);
  }

  private backupPath(instanceId: string, backupId: string): string {
    return resolve(this.dataRoot, "backups", `${instanceId}-${backupId}.tar.gz`);
  }

  private safeFilePath(instanceId: string, requestedPath: string): string {
    const root = this.instancePath(instanceId);
    const target = resolve(root, `.${requestedPath}`);
    const pathFromRoot = relative(root, target);
    if (pathFromRoot.startsWith("..") || pathFromRoot === "" && requestedPath !== "/") throw new Error("Unsafe file path");
    return target;
  }

  private async inspectOrUndefined(instanceId: string) {
    const container = this.docker.getContainer(this.containerName(instanceId));
    try {
      await container.inspect();
      return container;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode === 404) return undefined;
      throw error;
    }
  }

  private containerOptions(instance: InstanceSpec) {
    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, Record<string, never>> = {};
    for (const port of instance.ports) {
      const key = `${port.container}/${port.protocol}`;
      portBindings[key] = [{ HostPort: String(port.host) }];
      exposedPorts[key] = {};
    }
    const env: Record<string, string> = { ...instance.environment, VERSION: instance.version, MEMORY: `${instance.limits.memoryMb}M` };
    const isCustom = instance.kind === "custom";
    const command = isCustom
      ? ["sh", "-lc", `java -Xms${Math.max(256, Math.floor(instance.limits.memoryMb / 2))}M -Xmx${instance.limits.memoryMb}M -jar /data/${env.CUSTOM_JAR ?? "server.jar"} nogui`]
      : undefined;
    return {
      name: this.containerName(instance.id),
      Image: instance.image,
      Cmd: command,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      ExposedPorts: exposedPorts,
      HostConfig: {
        Binds: [`${this.instancePath(instance.id)}:/data`],
        PortBindings: portBindings,
        Memory: instance.limits.memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(instance.limits.cpuCores * 1_000_000_000),
        PidsLimit: instance.limits.pids,
        RestartPolicy: { Name: "unless-stopped" as const }
      },
      Labels: {
        "io.micopanel.managed": "true",
        "io.micopanel.instance": instance.id,
        "io.micopanel.kind": instance.kind
      }
    };
  }

  private async ensureConsole(instanceId: string): Promise<void> {
    if (this.consoleStreams.has(instanceId)) return;
    const container = this.docker.getContainer(this.containerName(instanceId));
    try {
      const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
      const output = new PassThrough();
      output.setEncoding("utf8");
      let remainder = "";
      output.on("data", (chunk: string) => {
        remainder += chunk.replace(/\r/g, "");
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) this.publishConsole(instanceId, line);
      });
      this.docker.modem.demuxStream(stream, output, output);
      stream.on("close", () => this.consoleStreams.delete(instanceId));
      stream.on("error", () => this.consoleStreams.delete(instanceId));
      this.consoleStreams.set(instanceId, stream);
    } catch {
      // A stopped container cannot be attached. The next start recreates the stream.
    }
  }

  private async recreate(instance: InstanceSpec): Promise<void> {
    const existing = await this.inspectOrUndefined(instance.id);
    if (existing) {
      try { await existing.stop({ t: 20 }); } catch { /* container may already be stopped */ }
      await existing.remove({ force: true });
    }
    await mkdir(this.instancePath(instance.id), { recursive: true });
    await this.docker.pull(instance.image);
    const container = await this.docker.createContainer(this.containerOptions(instance));
    await container.start();
    await this.ensureConsole(instance.id);
  }

  private async checkpoint(instance: InstanceSpec, release = false): Promise<void> {
    const stream = this.consoleStreams.get(instance.id);
    if (!stream) return;
    if (instance.kind === "bedrock") stream.write(release ? "save resume\n" : "save hold\n");
    else stream.write(release ? "save-on\n" : "save-all flush\nsave-off\n");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }

  private async uploadBackup(instanceId: string, backupId: string, archive: string): Promise<string> {
    if (!this.s3 || !this.s3Bucket) throw new Error("S3 backup target is not configured on this node");
    const key = `micopanel/${instanceId}/${backupId}.tar.gz`;
    await this.s3.send(new PutObjectCommand({ Bucket: this.s3Bucket, Key: key, Body: createReadStream(archive), ContentType: "application/gzip" }));
    return key;
  }

  private async downloadBackup(instanceId: string, backupId: string): Promise<string> {
    if (!this.s3 || !this.s3Bucket) throw new Error("S3 backup target is not configured on this node");
    const target = this.backupPath(instanceId, backupId);
    const key = `micopanel/${instanceId}/${backupId}.tar.gz`;
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.s3Bucket, Key: key }));
    if (!response.Body) throw new Error("S3 backup object has no body");
    await pipeline(response.Body as Readable, createWriteStream(target));
    return target;
  }

  private async restoreBackup(instance: InstanceSpec, backup: { id: string; destination: "local" | "s3" }): Promise<TaskResult> {
    let archive = this.backupPath(instance.id, backup.id);
    if (backup.destination === "s3") archive = await this.downloadBackup(instance.id, backup.id);
    if (!existsSync(archive)) throw new Error("备份文件不存在，无法恢复");
    const container = await this.inspectOrUndefined(instance.id);
    if (container) {
      try { await container.stop({ t: 30 }); } catch { /* already stopped is safe */ }
    }
    const current = this.instancePath(instance.id);
    const rollback = resolve(this.dataRoot, "archives", `${instance.id}-restore-${Date.now()}`);
    if (existsSync(current)) await rename(current, rollback);
    await mkdir(current, { recursive: true });
    try {
      await tar.x({ file: archive, cwd: current });
      await this.recreate(instance);
    } catch (error) {
      await rm(current, { recursive: true, force: true });
      if (existsSync(rollback)) await rename(rollback, current);
      throw error;
    }
    return { message: "备份已恢复，旧数据已作为节点归档保留" };
  }

  async execute(task: AgentTask): Promise<TaskResult> {
    const rawInstance = task.payload.instance;
    const instance = rawInstance as InstanceSpec | undefined;
    switch (task.type) {
      case "instance.create":
        if (!instance) throw new Error("Create task did not include an instance spec");
        await this.recreate(instance);
        return { message: "容器已创建并启动" };
      case "instance.start": {
        if (!instance) throw new Error("Start task did not include an instance spec");
        const container = await this.inspectOrUndefined(task.instanceId!);
        if (!container) await this.recreate(instance);
        else {
          const info = await container.inspect();
          if (!info.State.Running) await container.start();
          await this.ensureConsole(instance.id);
        }
        return { message: "实例已启动" };
      }
      case "instance.stop": {
        const container = await this.inspectOrUndefined(task.instanceId!);
        if (container) await container.stop({ t: 30 });
        return { message: "实例已停止" };
      }
      case "instance.restart": {
        if (!instance) throw new Error("Restart task did not include an instance spec");
        if (task.payload.applyConfig) await this.recreate(instance);
        else {
          const container = await this.inspectOrUndefined(task.instanceId!);
          if (container) await container.restart({ t: 30 });
          else await this.recreate(instance);
          await this.ensureConsole(instance.id);
        }
        return { message: "实例已重启" };
      }
      case "instance.kill": {
        const container = await this.inspectOrUndefined(task.instanceId!);
        if (container) await container.kill();
        return { message: "实例已强制停止" };
      }
      case "instance.command": {
        const stream = this.consoleStreams.get(task.instanceId!);
        const command = String(task.payload.command ?? "").trim();
        if (!stream || !command) throw new Error("实例控制台不可用，或命令为空");
        stream.write(`${command}\n`);
        return { message: "命令已写入控制台" };
      }
      case "file.write": {
        const path = String(task.payload.path ?? "");
        const content = String(task.payload.content ?? "");
        const target = this.safeFilePath(task.instanceId!, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { message: `已写入 ${path}` };
      }
      case "file.read": {
        const path = String(task.payload.path ?? "");
        const content = await readFile(this.safeFilePath(task.instanceId!, path), "utf8");
        return { message: `已读取 ${path}`, data: { content } };
      }
      case "file.list": {
        return { message: "文件目录已同步" };
      }
      case "instance.backup": {
        if (!instance) throw new Error("Backup task did not include an instance spec");
        const backupId = String(task.payload.backupId);
        const backupFile = this.backupPath(instance.id, backupId);
        await this.checkpoint(instance);
        try {
          await tar.c({ gzip: true, file: backupFile, cwd: this.instancePath(instance.id) }, ["."]);
        } finally {
          await this.checkpoint(instance, true);
        }
        const fileBuffer = await readFile(backupFile);
        const checksum = createHash("sha256").update(fileBuffer).digest("hex");
        const destination = task.payload.destination === "s3" ? "s3" : "local";
        const remoteKey = destination === "s3" ? await this.uploadBackup(instance.id, backupId, backupFile) : undefined;
        return { message: destination === "s3" ? "备份已上传到对象存储" : "备份归档已创建", data: { sizeBytes: fileBuffer.byteLength, checksum, path: remoteKey ?? basename(backupFile) } };
      }
      case "instance.restore": {
        if (!instance) throw new Error("Restore task did not include an instance spec");
        const backup = task.payload.backup as { id?: string; destination?: "local" | "s3" } | undefined;
        if (backup?.id && backup.destination) return this.restoreBackup(instance, { id: backup.id, destination: backup.destination });
        const archived = this.archivePath(instance.id);
        const current = this.instancePath(instance.id);
        if (!existsSync(archived)) throw new Error("归档目录不存在，无法恢复");
        if (existsSync(current)) await rm(current, { recursive: true, force: true });
        await rename(archived, current);
        return { message: "实例归档已恢复" };
      }
      case "instance.archive": {
        if (!instance) throw new Error("Archive task did not include an instance spec");
        const current = this.instancePath(instance.id);
        const archived = this.archivePath(instance.id);
        const container = await this.inspectOrUndefined(instance.id);
        if (container) {
          try { await container.stop({ t: 30 }); } catch { /* stopped is acceptable */ }
          await container.remove({ force: true });
        }
        if (task.payload.purge) {
          await rm(archived, { recursive: true, force: true });
          await rm(current, { recursive: true, force: true });
          return { message: "归档期已结束，实例文件已清理" };
        }
        if (existsSync(current)) {
          await rm(archived, { recursive: true, force: true });
          await rename(current, archived);
        }
        return { message: "实例已归档，等待恢复或自动清理" };
      }
      default:
        throw new Error("Unsupported task type");
    }
  }

  async usage(): Promise<NodeUsage> {
    const info = await this.docker.info();
    const disk = await stat(this.dataRoot);
    return {
      cpuPercent: 0,
      memoryBytes: 0,
      memoryLimitBytes: 0,
      diskBytes: disk.size,
      diskLimitBytes: 0,
      networkRxBytes: 0,
      networkTxBytes: 0
    };
  }
}
