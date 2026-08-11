import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import AdmZip from "adm-zip";
import Docker from "dockerode";
import * as tar from "tar";
import type { AgentTask, InstanceSpec, NodeUsage } from "@micopanel/protocol";
import type { S3Config } from "./config.js";

export interface TaskResult {
  message: string;
  data?: Record<string, unknown>;
}

type ProgressReporter = (message: string, progress: number) => void;

export class DockerRuntime {
  private readonly docker: Docker;
  private readonly consoleStreams = new Map<string, NodeJS.WritableStream>();
  private readonly s3?: S3Client;
  private readonly s3Bucket?: string;

  constructor(
    socketPath: string,
    private readonly dataRoot: string,
    private readonly publishConsole: (instanceId: string, line: string) => void,
    s3Config?: S3Config,
    private readonly controllerUrl?: string
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
    await mkdir(resolve(this.dataRoot, "transfers"), { recursive: true });
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

  private async safeFilePath(instanceId: string, requestedPath: string): Promise<string> {
    if (!requestedPath.startsWith("/") || requestedPath === "/" || requestedPath.includes("\\") || requestedPath.includes("\0")) throw new Error("Unsafe file path");
    const segments = requestedPath.split("/").slice(1);
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("Unsafe file path");
    const root = this.instancePath(instanceId);
    await mkdir(root, { recursive: true });
    const target = resolve(root, ...segments);
    const pathFromRoot = relative(root, target);
    if (pathFromRoot.startsWith("..") || pathFromRoot === "") throw new Error("Unsafe file path");
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || (index < segments.length - 1 && !metadata.isDirectory())) throw new Error("Unsafe file path");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    return target;
  }

  private transferPath(transferId: string, suffix: "upload" | "download"): string {
    if (!/^[a-z0-9-]{16,80}$/i.test(transferId)) throw new Error("Invalid file transfer id");
    return resolve(this.dataRoot, "transfers", `${transferId}.${suffix}`);
  }

  private async listFiles(instanceId: string): Promise<Array<{ path: string; size: number; modifiedAt: string }>> {
    const root = this.instancePath(instanceId);
    const files: Array<{ path: string; size: number; modifiedAt: string }> = [];
    const visit = async (directory: string): Promise<void> => {
      if (files.length >= 2000) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 2000 || entry.isSymbolicLink()) continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          const metadata = await stat(absolute);
          files.push({ path: `/${relative(root, absolute).replaceAll("\\", "/")}`, size: metadata.size, modifiedAt: metadata.mtime.toISOString() });
        }
      }
    };
    await visit(root);
    return files.sort((left, right) => left.path.localeCompare(right.path));
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
    const pullStream = await this.docker.pull(instance.image);
    await new Promise<void>((resolvePromise, reject) => {
      this.docker.modem.followProgress(pullStream, (error) => error ? reject(error) : resolvePromise());
    });
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

  private async downloadArtifact(instance: InstanceSpec, artifact: { id: string; fileName: string; token: string }): Promise<void> {
    if (!this.controllerUrl) throw new Error("Agent controller URL is not configured");
    const safeName = basename(artifact.fileName);
    const extension = extname(safeName).toLowerCase();
    if (!safeName || ![".jar", ".zip"].includes(extension)) throw new Error("任务中的制品类型无效");
    const root = this.instancePath(instance.id);
    await mkdir(root, { recursive: true });
    const url = new URL(this.controllerUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/artifacts/${artifact.id}`;
    url.searchParams.set("token", artifact.token);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`制品下载失败：${response.status}`);
    const temporary = resolve(root, `.micopanel-${artifact.id}${extension}`);
    await pipeline(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(temporary));
    if (extension === ".jar") {
      await rename(temporary, resolve(root, safeName));
      return;
    }
    try {
      const archive = new AdmZip(temporary);
      let unpackedBytes = 0;
      for (const entry of archive.getEntries()) {
        const destination = resolve(root, entry.entryName);
        const insideRoot = relative(root, destination);
        if (insideRoot.startsWith("..") || insideRoot === "") throw new Error("ZIP 包含不安全路径");
        if (entry.isDirectory) {
          await mkdir(destination, { recursive: true });
          continue;
        }
        unpackedBytes += entry.header.size;
        if (unpackedBytes > 2 * 1024 * 1024 * 1024) throw new Error("ZIP 解包内容超过 2 GB 安全限制");
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, entry.getData());
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async receiveFileTransfer(
    instanceId: string,
    path: string,
    transfer: { id: string; fileName: string; token: string; sizeBytes?: number; checksum?: string },
    reportProgress?: ProgressReporter
  ): Promise<TaskResult> {
    if (!this.controllerUrl) throw new Error("Agent controller URL is not configured");
    const expectedSize = Number(transfer.sizeBytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error("Invalid file transfer size");
    if (!/^[a-f0-9]{64}$/i.test(String(transfer.checksum ?? ""))) throw new Error("Invalid file transfer checksum");
    const url = new URL(this.controllerUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/file-transfers/${transfer.id}`;
    url.searchParams.set("token", transfer.token);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`文件下载失败：${response.status}`);
    const declaredChecksum = response.headers.get("x-micopanel-checksum");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredChecksum !== transfer.checksum || declaredSize !== expectedSize) throw new Error("文件传输元数据校验失败");
    const temporary = this.transferPath(transfer.id, "upload");
    const digest = createHash("sha256");
    let bytes = 0;
    let lastProgress = 10;
    const monitor = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      const progress = expectedSize ? Math.min(90, 10 + Math.floor((bytes / expectedSize) * 80)) : 10;
      if (progress >= lastProgress + 5) {
        lastProgress = progress;
        reportProgress?.("正在从控制端接收文件", progress);
      }
      digest.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]), monitor, createWriteStream(temporary, { flags: "w" }));
      if (bytes !== expectedSize || digest.digest("hex") !== transfer.checksum) throw new Error("文件传输完整性校验失败");
      const target = await this.safeFilePath(instanceId, path);
      await mkdir(dirname(target), { recursive: true });
      await rename(temporary, target);
      return { message: `已上传 ${path}`, data: { sizeBytes: bytes, checksum: transfer.checksum } };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async sendFileTransfer(
    instanceId: string,
    path: string,
    transfer: { id: string; fileName: string; token: string },
    reportProgress?: ProgressReporter
  ): Promise<TaskResult> {
    if (!this.controllerUrl) throw new Error("Agent controller URL is not configured");
    const source = await this.safeFilePath(instanceId, path);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("只能下载普通文件");
    const url = new URL(this.controllerUrl);
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/agent/file-transfers/${transfer.id}`;
    url.searchParams.set("token", transfer.token);
    let bytes = 0;
    let lastProgress = 10;
    const monitor = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      const progress = metadata.size ? Math.min(90, 10 + Math.floor((bytes / metadata.size) * 80)) : 90;
      if (progress >= lastProgress + 5) {
        lastProgress = progress;
        reportProgress?.("正在回传节点文件", progress);
      }
      callback(null, chunk);
    } });
    const sourceStream = createReadStream(source).pipe(monitor);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": String(metadata.size) },
      body: Readable.toWeb(sourceStream) as unknown as BodyInit,
      duplex: "half"
    } as RequestInit & { duplex: "half" });
    if (!response.ok) throw new Error(`文件回传失败：${response.status}`);
    const result = await response.json() as { checksum?: unknown; sizeBytes?: unknown };
    if (result.sizeBytes !== metadata.size || typeof result.checksum !== "string") throw new Error("控制端未确认文件回传");
    return { message: `已准备下载 ${path}`, data: { sizeBytes: metadata.size, checksum: result.checksum } };
  }

  async execute(task: AgentTask, reportProgress?: ProgressReporter): Promise<TaskResult> {
    const rawInstance = task.payload.instance;
    const instance = rawInstance as InstanceSpec | undefined;
    switch (task.type) {
      case "instance.create":
        if (!instance) throw new Error("Create task did not include an instance spec");
        {
          const artifact = task.payload.artifact as { id?: string; fileName?: string; token?: string } | undefined;
          if (artifact?.id && artifact.fileName && artifact.token) await this.downloadArtifact(instance, { id: artifact.id, fileName: artifact.fileName, token: artifact.token });
        }
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
        const target = await this.safeFilePath(task.instanceId!, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { message: `已写入 ${path}` };
      }
      case "file.read": {
        const path = String(task.payload.path ?? "");
        const target = await this.safeFilePath(task.instanceId!, path);
        const metadata = await stat(target);
        if (!metadata.isFile()) throw new Error("只能在编辑器中打开普通文件");
        if (metadata.size > 1_000_000) throw new Error("文件超过 1 MB，不能在面板编辑器中打开");
        const content = await readFile(target, "utf8");
        return { message: `已读取 ${path}`, data: { content } };
      }
      case "file.upload": {
        const path = String(task.payload.path ?? "");
        const transfer = task.payload.transfer as { id?: unknown; fileName?: unknown; token?: unknown; sizeBytes?: unknown; checksum?: unknown } | undefined;
        if (!transfer || typeof transfer.id !== "string" || typeof transfer.fileName !== "string" || typeof transfer.token !== "string" || typeof transfer.sizeBytes !== "number" || typeof transfer.checksum !== "string") throw new Error("文件上传任务无效");
        return this.receiveFileTransfer(task.instanceId!, path, { id: transfer.id, fileName: transfer.fileName, token: transfer.token, sizeBytes: transfer.sizeBytes, checksum: transfer.checksum }, reportProgress);
      }
      case "file.download": {
        const path = String(task.payload.path ?? "");
        const transfer = task.payload.transfer as { id?: unknown; fileName?: unknown; token?: unknown } | undefined;
        if (!transfer || typeof transfer.id !== "string" || typeof transfer.fileName !== "string" || typeof transfer.token !== "string") throw new Error("文件下载任务无效");
        return this.sendFileTransfer(task.instanceId!, path, { id: transfer.id, fileName: transfer.fileName, token: transfer.token }, reportProgress);
      }
      case "file.list": {
        return { message: "文件目录已同步", data: { files: await this.listFiles(task.instanceId!) } };
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
    const filesystem = await statfs(this.dataRoot);
    let networkRxBytes = 0;
    let networkTxBytes = 0;
    try {
      const rows = (await readFile("/proc/net/dev", "utf8")).split("\n").slice(2);
      for (const row of rows) {
        const values = row.replace(":", " ").trim().split(/\s+/).map(Number);
        if (values.length >= 10 && values.every((value) => Number.isFinite(value))) {
          networkRxBytes += values[1];
          networkTxBytes += values[9];
        }
      }
    } catch {
      // /proc is Linux-specific. Metrics other than network remain available on supported nodes.
    }
    const diskLimitBytes = filesystem.blocks * filesystem.bsize;
    return {
      cpuPercent: Math.min(100, (loadavg()[0] / Math.max(1, cpus().length)) * 100),
      memoryBytes: totalmem() - freemem(),
      memoryLimitBytes: totalmem(),
      diskBytes: Math.max(0, (filesystem.blocks - filesystem.bfree) * filesystem.bsize),
      diskLimitBytes,
      networkRxBytes,
      networkTxBytes
    };
  }
}
