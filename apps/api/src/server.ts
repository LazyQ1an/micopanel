import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Cron } from "croner";
import {
  ALL_INSTANCE_PERMISSIONS,
  SERVER_KINDS,
  type AgentInboundMessage,
  type AgentTask,
  type Permission,
  type TaskType,
  type UiEvent
} from "@micopanel/protocol";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import { hashPassword, hashToken, id, randomToken, verifyPassword, verifyToken } from "./security.js";
import {
  addAudit,
  allPermissions,
  canAccess,
  createAdminIfNeeded,
  createInstance,
  createNode,
  createTask,
  configurableEnvironment,
  findUser,
  instancePublic,
  isAdmin,
  managedEnvironment,
  isAutomaticRetryableTask,
  MAX_TASK_ATTEMPTS,
  MANAGED_ENVIRONMENT_KEYS,
  newBackup,
  newSchedule,
  nextTaskRetryAt,
  nodePublic,
  TASK_STALE_AFTER_MS,
  roleForNewUser,
  taskPublic,
  updateInstanceConfiguration
} from "./service.js";
import { createStore, type StateStore } from "./store.js";
import { SERVER_TEMPLATES } from "./templates.js";
import type { ArtifactRecord, BackupRecord, FileTransferRecord, InstanceRecord, ManagedFile, MetricPoint, NodeRecord, ScheduleRecord, TaskRecord, User } from "./types.js";

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (raw: Buffer) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: () => void): void;
};

const sessionCookie = "mico_session";
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 14;
const archiveRetentionMs = 1000 * 60 * 60 * 24 * 7;
const now = (): string => new Date().toISOString();
const transferPublic = ({ tokenHash: _tokenHash, ...transfer }: FileTransferRecord) => transfer;
const metricPoint = (usage: { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; networkRxBytes: number; networkTxBytes: number; diskBytes?: number; diskLimitBytes?: number }, capturedAt: string, pids?: number): MetricPoint => ({
  capturedAt,
  cpuPercent: Number.isFinite(usage.cpuPercent) ? Math.max(0, usage.cpuPercent) : 0,
  memoryBytes: Number.isFinite(usage.memoryBytes) ? Math.max(0, usage.memoryBytes) : 0,
  memoryLimitBytes: Number.isFinite(usage.memoryLimitBytes) ? Math.max(0, usage.memoryLimitBytes) : 0,
  networkRxBytes: Number.isFinite(usage.networkRxBytes) ? Math.max(0, usage.networkRxBytes) : 0,
  networkTxBytes: Number.isFinite(usage.networkTxBytes) ? Math.max(0, usage.networkTxBytes) : 0,
  diskBytes: typeof usage.diskBytes === "number" && Number.isFinite(usage.diskBytes) ? Math.max(0, usage.diskBytes) : undefined,
  diskLimitBytes: typeof usage.diskLimitBytes === "number" && Number.isFinite(usage.diskLimitBytes) ? Math.max(0, usage.diskLimitBytes) : undefined,
  pids: typeof pids === "number" && Number.isFinite(pids) ? Math.max(0, Math.floor(pids)) : undefined
});

const markTaskForRetry = (task: TaskRecord, reason: string): boolean => {
  if (!isAutomaticRetryableTask(task) || task.attempt >= MAX_TASK_ATTEMPTS) return false;
  task.status = "retrying";
  task.retryAt = nextTaskRetryAt(task.attempt);
  task.message = `${reason}；将在 ${task.retryAt} 自动重试`;
  task.progress = 0;
  task.updatedAt = now();
  return true;
};

class RealtimeHub {
  readonly agents = new Map<string, SocketLike>();
  readonly uiSockets = new Set<SocketLike>();

  broadcast(event: UiEvent): void {
    const payload = JSON.stringify(event);
    for (const socket of this.uiSockets) {
      if (socket.readyState === 1) socket.send(payload);
      else this.uiSockets.delete(socket);
    }
  }

  sendAgent(nodeId: string, message: unknown): boolean {
    const socket = this.agents.get(nodeId);
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
}

const userPublic = (user: User) => ({ id: user.id, username: user.username, role: user.role, createdAt: user.createdAt });
const unauthenticated = (reply: FastifyReply) => reply.code(401).send({ error: "需要登录后才能继续" });
const forbidden = (reply: FastifyReply) => reply.code(403).send({ error: "没有执行此操作的权限" });
const notFound = (reply: FastifyReply, message = "资源不存在") => reply.code(404).send({ error: message });

const bootstrapSchema = z.object({ username: z.string().min(3).max(32), password: z.string().min(10).max(128) });
const loginSchema = bootstrapSchema;
const nodeSchema = z.object({
  name: z.string().min(2).max(64),
  portRangeStart: z.number().int().min(1024).max(65534).default(25565),
  portRangeEnd: z.number().int().min(1025).max(65535).default(25665)
}).refine((value) => value.portRangeStart <= value.portRangeEnd, "端口范围无效");
const instanceSchema = z.object({
  name: z.string().min(2).max(64),
  nodeId: z.string().uuid(),
  kind: z.enum(SERVER_KINDS),
  version: z.string().min(1).max(64),
  memoryMb: z.number().int().min(512).max(262144),
  cpuCores: z.number().min(0.25).max(128),
  diskMb: z.number().int().min(1024).max(10485760),
  pids: z.number().int().min(64).max(32768).default(512),
  port: z.number().int().min(1024).max(65535).optional(),
  artifactId: z.string().uuid().optional(),
  customJar: z.string().min(1).max(128).refine((value) => !value.includes("/") && !value.includes("\\") && value.endsWith(".jar"), "自定义入口 JAR 无效").optional(),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(4096))
    .refine((environment) => Object.keys(environment).every((key) => !MANAGED_ENVIRONMENT_KEYS.has(key)), "不能修改受管环境变量")
    .default({}),
  eulaAccepted: z.literal(true)
});
const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill", "command"]), command: z.string().min(1).max(2000).optional() });
const backupSchema = z.object({ destination: z.enum(["local", "s3"]).default("local") });
const metricsQuerySchema = z.object({ minutes: z.coerce.number().int().min(15).max(1_440).default(180) });
const scheduleActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("command"), payload: z.object({ command: z.string().min(1).max(2000) }) }),
  z.object({ action: z.literal("backup"), payload: z.object({ destination: z.enum(["local", "s3"]).default("local") }).default({}) }),
  z.object({ action: z.literal("restart"), payload: z.object({}).default({}) })
]);
const scheduleSchema = z.object({ name: z.string().min(2).max(64), cron: z.string().min(9).max(128) }).and(scheduleActionSchema);
const scheduleUpdateSchema = z.object({ name: z.string().min(2).max(64), cron: z.string().min(9).max(128), enabled: z.boolean() }).and(scheduleActionSchema);
const memberSchema = z.object({ permissions: z.array(z.enum(ALL_INSTANCE_PERMISSIONS)).min(1) });
const userSchema = z.object({ username: z.string().min(3).max(32), password: z.string().min(10).max(128), role: z.enum(["admin", "user"]).default("user") });
const environmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(128), z.string().max(4096))
  .refine((environment) => Object.keys(environment).length <= 64, "环境变量数量不能超过 64 个")
  .refine((environment) => Object.keys(environment).every((key) => !MANAGED_ENVIRONMENT_KEYS.has(key)), "不能修改受管环境变量");
const limitsSchema = z.object({
  memoryMb: z.number().int().min(512).max(262144),
  cpuCores: z.number().min(0.25).max(128),
  diskMb: z.number().int().min(1024).max(10485760),
  pids: z.number().int().min(64).max(32768)
});
const instanceConfigurationSchema = z.object({
  version: z.string().min(1).max(64),
  port: z.number().int().min(1024).max(65535),
  environment: environmentSchema,
  limits: limitsSchema,
  confirmRecreate: z.literal(true)
});
const safeFilePath = (path: string): boolean => {
  if (!path.startsWith("/") || path === "/" || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment, index) => index === 0 || (segment.length > 0 && segment !== "." && segment !== ".."));
};
const filePathSchema = z.object({ path: z.string().min(2).max(512).refine(safeFilePath, "文件路径无效") });
const fileSchema = filePathSchema.extend({ content: z.string().max(10_000_000) });

export async function buildServer(options?: { config?: AppConfig; store?: StateStore }) {
  const config = options?.config ?? loadConfig();
  const store = options?.store ?? createStore(config.DATABASE_URL);
  await store.init();
  await Promise.all([mkdir(config.ARTIFACTS_DIR, { recursive: true }), mkdir(config.FILE_TRANSFERS_DIR, { recursive: true })]);

  const maxIncomingFileSize = Math.max(config.ARTIFACT_MAX_BYTES, config.FILE_TRANSFER_MAX_BYTES);
  const app = Fastify({ logger: config.NODE_ENV !== "test", bodyLimit: Math.max(10_500_000, maxIncomingFileSize + 1024), trustProxy: config.NODE_ENV === "production" });
  const hub = new RealtimeHub();
  await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
  await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { global: true, max: 180, timeWindow: "1 minute", skipOnError: true });
  await app.register(multipart, { limits: { files: 1, fileSize: maxIncomingFileSize } });
  app.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
  await app.register(websocket, { options: { maxPayload: 10_500_000 } });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    return payload;
  });

  const getCurrentUser = async (request: FastifyRequest): Promise<User | undefined> => {
    const signed = request.cookies[sessionCookie];
    if (!signed) return undefined;
    const result = request.unsignCookie(signed);
    if (!result.valid || !result.value) return undefined;
    const state = await store.read();
    const session = state.sessions.find((candidate) => candidate.id === result.value && new Date(candidate.expiresAt).getTime() > Date.now());
    return session ? findUser(state, session.userId) : undefined;
  };

  const setSession = async (reply: FastifyReply, userId: string): Promise<void> => {
    const sessionId = randomToken(32);
    const createdAt = now();
    await store.transaction((state) => {
      state.sessions = state.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
      state.sessions.push({ id: sessionId, userId, createdAt, expiresAt: new Date(Date.now() + sessionLifetimeMs).toISOString() });
    });
    reply.setCookie(sessionCookie, sessionId, {
      signed: true,
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(sessionLifetimeMs / 1000)
    });
  };

  const getInstanceAccess = async (request: FastifyRequest, reply: FastifyReply, permission: Permission) => {
    const user = await getCurrentUser(request);
    if (!user) return { user: undefined, instance: undefined, response: unauthenticated(reply) };
    const instanceId = (request.params as { id: string }).id;
    const state = await store.read();
    const instance = state.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return { user: undefined, instance: undefined, response: notFound(reply, "实例不存在") };
    if (!canAccess(state, user, instance, permission)) return { user: undefined, instance: undefined, response: forbidden(reply) };
    return { user, instance };
  };

  const getInstanceManagerAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getCurrentUser(request);
    if (!user) return { user: undefined, instance: undefined, response: unauthenticated(reply) };
    const instanceId = (request.params as { id: string }).id;
    const state = await store.read();
    const instance = state.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) return { user: undefined, instance: undefined, response: notFound(reply, "实例不存在") };
    if (!isAdmin(user) && instance.ownerId !== user.id) return { user: undefined, instance: undefined, response: forbidden(reply) };
    return { user, instance };
  };

  const canScheduleAction = async (user: User, instance: InstanceRecord, action: ScheduleRecord["action"]): Promise<boolean> => {
    const permission: Record<ScheduleRecord["action"], Permission> = {
      command: "instance.console",
      restart: "instance.power",
      backup: "instance.backups"
    };
    return canAccess(await store.read(), user, instance, permission[action]);
  };

  const deliverTask = async (taskId: string): Promise<void> => {
    const snapshot = await store.read();
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "queued") return;
    const reserved = await store.transaction((state) => {
      const target = state.tasks.find((candidate) => candidate.id === taskId);
      if (!target || target.status !== "queued") return undefined;
      target.status = "delivered";
      target.attempt += 1;
      target.retryAt = undefined;
      target.updatedAt = now();
      return { nodeId: target.nodeId, task: { id: target.id, type: target.type, instanceId: target.instanceId, payload: target.payload, attempt: target.attempt } satisfies AgentTask };
    });
    if (!reserved) return;
    if (!hub.sendAgent(reserved.nodeId, { type: "task", task: reserved.task })) {
      await store.transaction((state) => {
        const target = state.tasks.find((candidate) => candidate.id === taskId);
        if (!target || target.status !== "delivered") return;
        target.status = "queued";
        target.attempt = Math.max(0, target.attempt - 1);
        target.message = "节点尚未连接，等待重新投递";
        target.updatedAt = now();
      });
      return;
    }
    hub.broadcast({ type: "task.updated", taskId, status: "delivered", attempt: reserved.task.attempt });
  };

  const enqueue = async (actorId: string, input: { type: TaskType; nodeId: string; instanceId?: string; payload?: Record<string, unknown> }): Promise<TaskRecord> => {
    const task = await createTask(store, actorId, input);
    await deliverTask(task.id);
    return task;
  };

  const sendPendingTasks = async (nodeId: string): Promise<void> => {
    const state = await store.read();
    await Promise.all(state.tasks.filter((task) => task.nodeId === nodeId && task.status === "queued").map((task) => deliverTask(task.id)));
  };

  const attachAgent = async (node: NodeRecord, socket: SocketLike): Promise<void> => {
    const previous = hub.agents.get(node.id);
    if (previous && previous !== socket) previous.close(4001, "superseded by new agent connection");
    hub.agents.set(node.id, socket);
    await store.transaction((state) => {
      const target = state.nodes.find((candidate) => candidate.id === node.id);
      if (!target) return;
      target.online = true;
      target.lastSeenAt = now();
    });
    hub.broadcast({ type: "node.updated", nodeId: node.id, online: true });
    await sendPendingTasks(node.id);
  };

  const agentTaskResult = async (nodeId: string, message: Extract<AgentInboundMessage, { type: "task.result" }>): Promise<void> => {
    let status: "succeeded" | "failed" | "retrying" = message.ok ? "succeeded" : "failed";
    let instanceId: string | undefined;
    let transferStorageToRemove: string | undefined;
    let retryAt: string | undefined;
    let attempt = 0;
    let retryScheduled = false;
    let processed = false;
    await store.transaction((state) => {
      const task = state.tasks.find((candidate) => candidate.id === message.taskId && candidate.nodeId === nodeId);
      if (!task || task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") return;
      processed = true;
      if (!message.ok && markTaskForRetry(task, message.message ?? "Agent task failed")) {
        status = "retrying";
        retryScheduled = true;
      } else {
        task.status = status;
        task.retryAt = undefined;
        task.message = message.message;
        task.progress = 100;
      }
      retryAt = task.retryAt;
      attempt = task.attempt;
      task.updatedAt = now();
      instanceId = task.instanceId;
      const instance = task.instanceId ? state.instances.find((candidate) => candidate.id === task.instanceId) : undefined;
      if (instance) {
        instance.updatedAt = now();
        if (!message.ok) {
          if (!retryScheduled) {
            instance.lastError = message.message ?? "Agent task failed";
            if (task.type === "instance.create") instance.status = "error";
          }
        } else {
          if (task.type === "instance.create" || task.type === "instance.stop" || task.type === "instance.kill") instance.status = "offline";
          else if (task.type === "instance.start" || task.type === "instance.restart") instance.status = "running";
          else if (task.type === "instance.restore") instance.status = task.payload.backup ? "running" : "offline";
          else if (task.type === "instance.archive") instance.status = "archived";
        }
      }
      if (task.type === "instance.backup") {
        const backup = state.backups.find((candidate) => candidate.id === String(task.payload.backupId));
        if (backup) {
          backup.status = message.ok ? "available" : retryScheduled ? "creating" : "failed";
          backup.sizeBytes = Number(message.data?.sizeBytes) || undefined;
          backup.checksum = typeof message.data?.checksum === "string" ? message.data.checksum : undefined;
        }
      }
      if (task.type === "file.list" && instance && Array.isArray(message.data?.files)) {
        instance.fileIndex = message.data.files
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .filter((entry) => typeof entry.path === "string" && typeof entry.size === "number" && typeof entry.modifiedAt === "string")
          .slice(0, 2000)
          .map((entry) => ({ path: entry.path as string, size: entry.size as number, modifiedAt: entry.modifiedAt as string } satisfies ManagedFile));
      }
      if (task.type === "file.read" && instance && typeof task.payload.path === "string" && typeof message.data?.content === "string") {
        instance.files[task.payload.path] = message.data.content;
      }
      if ((task.type === "file.upload" || task.type === "file.download") && typeof (task.payload.transfer as { id?: unknown } | undefined)?.id === "string") {
        const transfer = state.fileTransfers.find((candidate) => candidate.id === (task.payload.transfer as { id: string }).id);
        if (transfer) {
          if (task.type === "file.upload") {
            transfer.status = message.ok ? "available" : "failed";
            transfer.error = message.ok ? undefined : message.message ?? "节点文件写入失败";
            transfer.updatedAt = now();
            transferStorageToRemove = transfer.storageName;
          } else if (!message.ok && transfer.status !== "available") {
            transfer.status = "failed";
            transfer.error = message.message ?? "节点文件回传失败";
            transfer.updatedAt = now();
          }
        }
      }
      addAudit(state, "agent", message.ok ? "task.succeeded" : retryScheduled ? "task.retry.scheduled" : "task.failed", task.id, message.message);
    });
    if (!processed) return;
    if (transferStorageToRemove) await rm(getTransferFilePath(transferStorageToRemove), { force: true });
    hub.broadcast({ type: "task.updated", taskId: message.taskId, status, message: message.message, progress: retryScheduled ? 0 : 100, retryAt, attempt });
    if (instanceId) {
      const state = await store.read();
      const instance = state.instances.find((candidate) => candidate.id === instanceId);
      if (instance) hub.broadcast({ type: "instance.updated", instanceId, status: instance.status });
    }
  };

  const handleAgentMessage = async (socket: SocketLike, raw: Buffer, connectedNodeId?: string): Promise<string | undefined> => {
    let message: AgentInboundMessage;
    try {
      message = JSON.parse(raw.toString()) as AgentInboundMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid JSON message" }));
      return connectedNodeId;
    }

    if (message.type === "register") {
      const state = await store.read();
      const node = state.nodes.find((candidate) => candidate.enrollmentTokenHash && verifyToken(message.token, candidate.enrollmentTokenHash));
      if (!node) {
        socket.send(JSON.stringify({ type: "error", message: "Enrollment token is invalid or already used" }));
        socket.close(4403, "invalid enrollment token");
        return undefined;
      }
      const certificate = randomToken(32);
      await store.transaction((draft) => {
        const target = draft.nodes.find((candidate) => candidate.id === node.id);
        if (!target) return;
        target.name = message.nodeName.trim() || target.name;
        target.enrollmentTokenHash = undefined;
        target.agentCredentialHash = hashToken(certificate);
        target.agentVersion = message.agentVersion;
        target.capabilities = message.capabilities;
        addAudit(draft, "agent", "node.enrolled", target.id, target.name);
      });
      socket.send(JSON.stringify({ type: "registered", nodeId: node.id, certificate }));
      await attachAgent(node, socket);
      return node.id;
    }

    if (message.type === "authenticate") {
      const state = await store.read();
      const node = state.nodes.find((candidate) => candidate.id === message.nodeId && candidate.agentCredentialHash && verifyToken(message.certificate, candidate.agentCredentialHash));
      if (!node) {
        socket.send(JSON.stringify({ type: "error", message: "Agent credential rejected" }));
        socket.close(4403, "invalid agent credential");
        return undefined;
      }
      await store.transaction((draft) => {
        const target = draft.nodes.find((candidate) => candidate.id === node.id);
        if (!target) return;
        target.agentVersion = message.agentVersion;
        target.capabilities = message.capabilities;
      });
      await attachAgent(node, socket);
      return node.id;
    }

    if (!connectedNodeId) {
      socket.close(4401, "authenticate before sending messages");
      return undefined;
    }

    if (message.type === "heartbeat") {
      await store.transaction((state) => {
        const node = state.nodes.find((candidate) => candidate.id === connectedNodeId);
        if (!node) return;
        node.online = true;
        node.lastSeenAt = now();
        node.usage = message.usage;
      });
      const workload = message.usage.workloads;
      if (workload && !Number.isNaN(Date.parse(workload.capturedAt))) {
        try {
          const state = await store.read();
          const instanceIds = new Set(state.instances.filter((instance) => instance.nodeId === connectedNodeId).map((instance) => instance.id));
          await store.appendMetrics({
            nodeId: connectedNodeId,
            capturedAt: workload.capturedAt,
            node: metricPoint(message.usage, workload.capturedAt),
            instances: Object.entries(workload.instances ?? {})
              .filter(([instanceId]) => instanceIds.has(instanceId))
              .map(([instanceId, usage]) => ({ instanceId, point: metricPoint(usage, workload.capturedAt, usage.pids) }))
          });
        } catch {
          // Metrics are supplementary; a storage hiccup must not disconnect a healthy Agent.
        }
      }
      hub.broadcast({ type: "node.updated", nodeId: connectedNodeId, online: true, usage: message.usage });
      return connectedNodeId;
    }
    if (message.type === "task.ack" || message.type === "task.progress") {
      await store.transaction((state) => {
        const task = state.tasks.find((candidate) => candidate.id === message.taskId && candidate.nodeId === connectedNodeId);
        if (!task) return;
        task.status = "running";
        task.message = message.type === "task.progress" ? message.message : "Agent accepted task";
        task.progress = message.type === "task.progress" ? message.progress : task.progress;
        task.updatedAt = now();
      });
      hub.broadcast({ type: "task.updated", taskId: message.taskId, status: "running", message: message.type === "task.progress" ? message.message : "Agent accepted task", progress: message.type === "task.progress" ? message.progress : undefined });
      return connectedNodeId;
    }
    if (message.type === "task.result") {
      await agentTaskResult(connectedNodeId, message);
      return connectedNodeId;
    }
    if (message.type === "console.output") {
      await store.transaction((state) => {
        const instance = state.instances.find((candidate) => candidate.id === message.instanceId && candidate.nodeId === connectedNodeId);
        if (!instance) return;
        instance.console.push(message.line);
        instance.console = instance.console.slice(-500);
      });
      hub.broadcast({ type: "console.output", instanceId: message.instanceId, line: message.line });
      return connectedNodeId;
    }
    if (message.type === "instance.state") {
      await store.transaction((state) => {
        const instance = state.instances.find((candidate) => candidate.id === message.instanceId && candidate.nodeId === connectedNodeId);
        if (!instance) return;
        instance.status = message.status;
        instance.updatedAt = now();
      });
      hub.broadcast({ type: "instance.updated", instanceId: message.instanceId, status: message.status });
      return connectedNodeId;
    }
    return connectedNodeId;
  };

  app.get("/health", async () => ({ ok: true, service: "micopanel-api", storage: config.DATABASE_URL ? "postgres" : "memory" }));

  app.get("/api/templates", async () => ({ templates: SERVER_TEMPLATES }));

  app.get("/api/agent/artifacts/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = z.object({ token: z.string().min(32) }).parse(request.query);
    const artifact = (await store.read()).artifacts.find((candidate) => candidate.id === params.id);
    if (!artifact?.downloadTokenHash || !artifact.tokenExpiresAt || new Date(artifact.tokenExpiresAt).getTime() < Date.now() || !verifyToken(query.token, artifact.downloadTokenHash)) {
      return reply.code(403).send({ error: "制品下载授权无效或已过期" });
    }
    const filePath = resolve(config.ARTIFACTS_DIR, artifact.storageName);
    if (relative(resolve(config.ARTIFACTS_DIR), filePath).startsWith("..")) return reply.code(400).send({ error: "制品路径无效" });
    try { await stat(filePath); } catch { return notFound(reply, "制品文件不存在"); }
    reply.type(artifact.mimeType).header("Content-Disposition", `attachment; filename="${encodeURIComponent(artifact.fileName)}"`);
    return reply.send(createReadStream(filePath));
  });

  const getTransferFilePath = (storageName: string): string => {
    const root = resolve(config.FILE_TRANSFERS_DIR);
    const filePath = resolve(root, storageName);
    if (relative(root, filePath).startsWith("..")) throw new Error("文件传输路径无效");
    return filePath;
  };

  app.get("/api/agent/file-transfers/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const query = z.object({ token: z.string().min(32) }).parse(request.query);
    const transfer = (await store.read()).fileTransfers.find((candidate) => candidate.id === params.id);
    if (!transfer || transfer.direction !== "upload" || transfer.status !== "queued" || new Date(transfer.expiresAt).getTime() < Date.now() || !verifyToken(query.token, transfer.tokenHash)) {
      return reply.code(403).send({ error: "文件上传授权无效或已过期" });
    }
    const filePath = getTransferFilePath(transfer.storageName);
    try { await stat(filePath); } catch { return notFound(reply, "待上传文件不存在"); }
    reply
      .type(transfer.mimeType)
      .header("Content-Length", String(transfer.sizeBytes ?? 0))
      .header("X-MicoPanel-Checksum", transfer.checksum ?? "")
      .header("X-MicoPanel-Path", encodeURIComponent(transfer.path));
    return reply.send(createReadStream(filePath));
  });

  app.post("/api/agent/file-transfers/:id", { config: { bodyLimit: config.FILE_TRANSFER_MAX_BYTES + 1024 } }, async (request, reply) => {
    const params = request.params as { id: string };
    const query = z.object({ token: z.string().min(32) }).parse(request.query);
    const transfer = (await store.read()).fileTransfers.find((candidate) => candidate.id === params.id);
    if (!transfer || transfer.direction !== "download" || transfer.status !== "queued" || new Date(transfer.expiresAt).getTime() < Date.now() || !verifyToken(query.token, transfer.tokenHash)) {
      return reply.code(403).send({ error: "文件下载授权无效或已过期" });
    }
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > config.FILE_TRANSFER_MAX_BYTES) {
      return reply.code(413).send({ error: "文件大小超过传输限制" });
    }
    const destination = getTransferFilePath(transfer.storageName);
    await store.transaction((state) => {
      const target = state.fileTransfers.find((candidate) => candidate.id === transfer.id);
      if (!target || target.status !== "queued") return;
      target.status = "receiving";
      target.updatedAt = now();
    });
    const digest = createHash("sha256");
    let bytes = 0;
    const hashStream = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > config.FILE_TRANSFER_MAX_BYTES) return callback(new Error("文件大小超过传输限制"));
      digest.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(request.body as NodeJS.ReadableStream, hashStream, createWriteStream(destination, { flags: "wx" }));
      const checksum = digest.digest("hex");
      await store.transaction((state) => {
        const target = state.fileTransfers.find((candidate) => candidate.id === transfer.id);
        if (!target) return;
        target.status = "available";
        target.sizeBytes = bytes;
        target.checksum = checksum;
        target.updatedAt = now();
        addAudit(state, "agent", "file.download.received", `${target.instanceId}:${target.path}`, `${bytes} bytes`);
      });
      return reply.code(201).send({ ok: true, checksum, sizeBytes: bytes });
    } catch (error) {
      await rm(destination, { force: true });
      await store.transaction((state) => {
        const target = state.fileTransfers.find((candidate) => candidate.id === transfer.id);
        if (!target) return;
        target.status = "failed";
        target.error = error instanceof Error ? error.message : "节点文件回传失败";
        target.updatedAt = now();
      });
      throw error;
    }
  });

  app.get("/api/auth/status", async (request) => {
    const state = await store.read();
    const user = await getCurrentUser(request);
    return { setupRequired: state.users.length === 0, user: user ? userPublic(user) : null };
  });

  app.post("/api/auth/bootstrap", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const input = bootstrapSchema.parse(request.body);
    const created = await createAdminIfNeeded(store, input.username, await hashPassword(input.password));
    if (!created) return reply.code(409).send({ error: "管理员已经初始化" });
    const state = await store.read();
    const user = state.users.find((candidate) => candidate.username === input.username)!;
    await setSession(reply, user.id);
    await store.transaction((draft) => addAudit(draft, user.id, "auth.bootstrap", user.id));
    return { user: userPublic(user) };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const state = await store.read();
    const user = state.users.find((candidate) => candidate.username.toLowerCase() === input.username.toLowerCase());
    if (!user || !(await verifyPassword(user.passwordHash, input.password))) return reply.code(401).send({ error: "用户名或密码不正确" });
    await setSession(reply, user.id);
    await store.transaction((draft) => addAudit(draft, user.id, "auth.login", user.id));
    return { user: userPublic(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const signed = request.cookies[sessionCookie];
    const value = signed ? request.unsignCookie(signed).value : undefined;
    if (value) await store.transaction((state) => { state.sessions = state.sessions.filter((session) => session.id !== value); });
    reply.clearCookie(sessionCookie, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/dashboard", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const state = await store.read();
    const visible = state.instances.filter((instance) => canAccess(state, user, instance, "instance.view"));
    return {
      instances: visible.map(instancePublic),
      nodes: isAdmin(user) ? state.nodes.map(nodePublic) : state.nodes.filter((node) => visible.some((instance) => instance.nodeId === node.id)).map(nodePublic),
      tasks: state.tasks.filter((task) => !task.instanceId || visible.some((instance) => instance.id === task.instanceId)).slice(0, 30).map(taskPublic),
      backups: state.backups.filter((backup) => visible.some((instance) => instance.id === backup.instanceId)),
      summary: {
        onlineNodes: state.nodes.filter((node) => node.online).length,
        totalNodes: state.nodes.length,
        runningInstances: visible.filter((instance) => instance.status === "running").length,
        totalInstances: visible.filter((instance) => instance.status !== "archived").length,
        queuedTasks: state.tasks.filter((task) => ["queued", "delivered", "running"].includes(task.status)).length
      }
    };
  });

  app.get("/api/users", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const state = await store.read();
    return { users: state.users.map(userPublic) };
  });

  app.post("/api/users", async (request, reply) => {
    const actor = await getCurrentUser(request);
    if (!actor) return unauthenticated(reply);
    if (!isAdmin(actor)) return forbidden(reply);
    const input = userSchema.parse(request.body);
    const user = await store.transaction(async (state) => {
      if (state.users.some((candidate) => candidate.username.toLowerCase() === input.username.toLowerCase())) throw new Error("用户名已存在");
      const created: User = { id: id(), username: input.username, passwordHash: await hashPassword(input.password), role: roleForNewUser(input.role), createdAt: now() };
      state.users.push(created);
      addAudit(state, actor.id, "user.created", created.id, created.username);
      return created;
    });
    return reply.code(201).send({ user: userPublic(user) });
  });

  app.get("/api/nodes", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const state = await store.read();
    return { nodes: state.nodes.map(nodePublic) };
  });

  app.get("/api/nodes/:id/metrics", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const nodeId = (request.params as { id: string }).id;
    if (!(await store.read()).nodes.some((node) => node.id === nodeId)) return notFound(reply, "节点不存在");
    const input = metricsQuerySchema.parse(request.query);
    return { metrics: await store.getMetrics("node", nodeId, new Date(Date.now() - input.minutes * 60_000)) };
  });

  app.post("/api/nodes", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const input = nodeSchema.parse(request.body);
    const result = await createNode(store, user.id, input);
    return reply.code(201).send({ node: nodePublic(result.node), enrollmentToken: result.enrollmentToken });
  });

  app.get("/api/artifacts", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const state = await store.read();
    return { artifacts: state.artifacts.map(({ downloadTokenHash: _token, ...artifact }) => artifact) };
  });

  app.post("/api/artifacts", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const part = await request.file();
    if (!part) return reply.code(422).send({ error: "请上传 JAR 或 ZIP 服务端包" });
    const fileName = basename(part.filename || "");
    const extension = extname(fileName).toLowerCase();
    if (!fileName || ![".jar", ".zip"].includes(extension)) {
      part.file.resume();
      return reply.code(422).send({ error: "仅支持 .jar 和 .zip 服务端包" });
    }
    const artifactId = id();
    const storageName = `${artifactId}${extension}`;
    const destination = resolve(config.ARTIFACTS_DIR, storageName);
    const digest = createHash("sha256");
    const hashStream = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(part.file, hashStream, createWriteStream(destination, { flags: "wx" }));
      if (part.file.truncated) throw new Error("上传文件超过大小限制");
      const metadata = await stat(destination);
      const artifact: ArtifactRecord = { id: artifactId, fileName, storageName, mimeType: part.mimetype || "application/octet-stream", sizeBytes: metadata.size, checksum: digest.digest("hex"), createdBy: user.id, createdAt: now() };
      await store.transaction((state) => {
        state.artifacts.unshift(artifact);
        addAudit(state, user.id, "artifact.uploaded", artifact.id, artifact.fileName);
      });
      return reply.code(201).send({ artifact });
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  });

  app.get("/api/instances", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const state = await store.read();
    return { instances: state.instances.filter((instance) => canAccess(state, user, instance, "instance.view")).map(instancePublic) };
  });

  app.post("/api/instances", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const input = instanceSchema.parse(request.body);
    const state = await store.read();
    if (!isAdmin(user) && !state.nodes.some((node) => node.id === input.nodeId)) return forbidden(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const artifact = input.artifactId ? state.artifacts.find((candidate) => candidate.id === input.artifactId) : undefined;
    if (input.kind === "custom" && !artifact) return reply.code(422).send({ error: "自定义服务端必须选择已上传的 JAR 或 ZIP 制品" });
    if (artifact && input.kind !== "custom") return reply.code(422).send({ error: "仅自定义服务端可以使用上传制品" });
    const customJar = artifact ? (input.customJar ?? (artifact.fileName.endsWith(".jar") ? artifact.fileName : "server.jar")) : undefined;
    const instance = await createInstance(store, user.id, { ...input, customJar });
    let artifactTask: { id: string; fileName: string; token: string } | undefined;
    if (artifact) {
      const token = randomToken(32);
      await store.transaction((draft) => {
        const target = draft.artifacts.find((candidate) => candidate.id === artifact.id);
        if (!target) return;
        target.downloadTokenHash = hashToken(token);
        target.tokenExpiresAt = new Date(Date.now() + config.ARTIFACT_TOKEN_TTL_MINUTES * 60_000).toISOString();
      });
      artifactTask = { id: artifact.id, fileName: artifact.fileName, token };
    }
    const task = await enqueue(user.id, { type: "instance.create", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, artifact: artifactTask } });
    return reply.code(202).send({ instance: instancePublic(instance), task: taskPublic(task) });
  });

  app.get("/api/instances/:id", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.view");
    if (!access.user || !access.instance) return access.response;
    const state = await store.read();
    return {
      instance: instancePublic(access.instance),
      configuration: {
        environment: configurableEnvironment(access.instance),
        managedEnvironment: managedEnvironment(access.instance)
      },
      members: state.members.filter((member) => member.instanceId === access.instance!.id),
      console: access.instance.console,
      files: access.instance.fileIndex,
      backups: state.backups.filter((backup) => backup.instanceId === access.instance!.id),
      schedules: state.schedules.filter((schedule) => schedule.instanceId === access.instance!.id)
    };
  });

  app.get("/api/instances/:id/metrics", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.view");
    if (!access.instance) return access.response;
    const input = metricsQuerySchema.parse(request.query);
    return { metrics: await store.getMetrics("instance", access.instance.id, new Date(Date.now() - input.minutes * 60_000)) };
  });

  app.get("/api/instances/:id/members", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.view");
    if (!access.user || !access.instance) return access.response;
    const state = await store.read();
    const canManage = isAdmin(access.user) || access.instance.ownerId === access.user.id;
    return {
      owner: userPublic(state.users.find((candidate) => candidate.id === access.instance!.ownerId)!),
      members: state.members
        .filter((member) => member.instanceId === access.instance!.id)
        .map((member) => ({ ...member, user: userPublic(state.users.find((candidate) => candidate.id === member.userId)!) })),
      users: canManage ? state.users.filter((candidate) => candidate.id !== access.instance!.ownerId).map(userPublic) : [],
      canManage,
      canCreateUsers: canManage && isAdmin(access.user)
    };
  });

  app.post("/api/instances/:id/actions", async (request, reply) => {
    const input = actionSchema.parse(request.body);
    const permission: Permission = input.action === "command" ? "instance.console" : "instance.power";
    const access = await getInstanceAccess(request, reply, permission);
    if (!access.user || !access.instance) return access.response;
    const taskType: Record<typeof input.action, TaskType> = {
      start: "instance.start", stop: "instance.stop", restart: "instance.restart", kill: "instance.kill", command: "instance.command"
    };
    const task = await enqueue(access.user.id, { type: taskType[input.action], nodeId: access.instance.nodeId, instanceId: access.instance.id, payload: input.action === "command" ? { command: input.command } : { instance: access.instance } });
    await store.transaction((state) => {
      const instance = state.instances.find((candidate) => candidate.id === access.instance!.id);
      if (!instance) return;
      if (input.action === "start") instance.status = "starting";
      if (input.action === "stop") instance.status = "stopping";
      instance.updatedAt = now();
    });
    return reply.code(202).send({ task: taskPublic(task) });
  });

  app.put("/api/instances/:id/config", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.config");
    if (!access.user || !access.instance) return access.response;
    if (access.instance.status === "archived") return reply.code(409).send({ error: "归档实例必须恢复后才能修改配置" });
    const input = instanceConfigurationSchema.parse(request.body);
    const instance = await updateInstanceConfiguration(store, access.user.id, access.instance.id, input);
    const task = await enqueue(access.user.id, { type: "instance.restart", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, applyConfig: true } });
    return reply.code(202).send({
      instance: instancePublic(instance),
      configuration: { environment: configurableEnvironment(instance), managedEnvironment: managedEnvironment(instance) },
      task: taskPublic(task)
    });
  });

  app.get("/api/instances/:id/files", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const path = typeof (request.query as { path?: string }).path === "string" ? (request.query as { path: string }).path : "/";
    if (path !== "/" && !safeFilePath(`${path}/placeholder`)) return reply.code(422).send({ error: "目录路径无效" });
    const prefix = path === "/" ? "/" : `${path}/`;
    const files = access.instance.fileIndex.filter((file) => file.path === path || file.path.startsWith(prefix)).map((file) => ({ ...file, content: access.instance!.files[file.path] }));
    return { files };
  });

  app.get("/api/instances/:id/file-transfers/:transferId", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const transferId = (request.params as { transferId: string }).transferId;
    const transfer = (await store.read()).fileTransfers.find((candidate) => candidate.id === transferId && candidate.instanceId === access.instance!.id);
    if (!transfer) return notFound(reply, "文件传输不存在");
    return { transfer: transferPublic(transfer) };
  });

  app.get("/api/instances/:id/file-transfers/:transferId/download", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const transferId = (request.params as { transferId: string }).transferId;
    const transfer = (await store.read()).fileTransfers.find((candidate) => candidate.id === transferId && candidate.instanceId === access.instance!.id);
    if (!transfer || transfer.direction !== "download" || transfer.status !== "available") return notFound(reply, "下载文件尚未就绪");
    if (new Date(transfer.expiresAt).getTime() < Date.now()) return reply.code(410).send({ error: "下载文件已过期" });
    const filePath = getTransferFilePath(transfer.storageName);
    try { await stat(filePath); } catch { return notFound(reply, "下载文件不存在"); }
    reply.type(transfer.mimeType).header("Content-Disposition", `attachment; filename="${encodeURIComponent(transfer.fileName)}"`);
    return reply.send(createReadStream(filePath));
  });

  app.post("/api/instances/:id/files/sync", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const task = await enqueue(access.user.id, { type: "file.list", nodeId: access.instance.nodeId, instanceId: access.instance.id });
    return reply.code(202).send({ task: taskPublic(task) });
  });

  app.post("/api/instances/:id/files/read", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const input = filePathSchema.parse(request.body);
    await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id);
      if (target) delete target.files[input.path];
    });
    const task = await enqueue(access.user.id, { type: "file.read", nodeId: access.instance.nodeId, instanceId: access.instance.id, payload: input });
    return reply.code(202).send({ task: taskPublic(task) });
  });

  app.post("/api/instances/:id/files/upload", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const input = filePathSchema.parse(request.query);
    const part = await request.file();
    if (!part) return reply.code(422).send({ error: "请选择要上传的文件" });
    const fileName = basename(part.filename || "");
    if (!fileName || fileName === "." || fileName.length > 255) {
      part.file.resume();
      return reply.code(422).send({ error: "文件名无效" });
    }
    const transferId = id();
    const storageName = `${transferId}.upload`;
    const destination = getTransferFilePath(storageName);
    const digest = createHash("sha256");
    const hashStream = new Transform({ transform(chunk, _encoding, callback) { digest.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(part.file, hashStream, createWriteStream(destination, { flags: "wx" }));
      if (part.file.truncated) throw new Error("上传文件超过大小限制");
      const metadata = await stat(destination);
      if (metadata.size > config.FILE_TRANSFER_MAX_BYTES) throw new Error("上传文件超过大小限制");
      const token = randomToken(32);
      const transfer: FileTransferRecord = {
        id: transferId,
        instanceId: access.instance.id,
        nodeId: access.instance.nodeId,
        direction: "upload",
        path: input.path,
        fileName,
        storageName,
        mimeType: part.mimetype || "application/octet-stream",
        sizeBytes: metadata.size,
        checksum: digest.digest("hex"),
        status: "queued",
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + config.FILE_TRANSFER_TOKEN_TTL_MINUTES * 60_000).toISOString(),
        createdBy: access.user.id,
        createdAt: now(),
        updatedAt: now()
      };
      await store.transaction((state) => {
        state.fileTransfers.unshift(transfer);
        addAudit(state, access.user!.id, "file.upload.queued", `${access.instance!.id}:${input.path}`, `${metadata.size} bytes`);
      });
      const task = await enqueue(access.user.id, {
        type: "file.upload",
        nodeId: access.instance.nodeId,
        instanceId: access.instance.id,
        payload: { path: input.path, transfer: { id: transfer.id, fileName: transfer.fileName, token, sizeBytes: transfer.sizeBytes, checksum: transfer.checksum } }
      });
      return reply.code(202).send({ transfer: transferPublic(transfer), task: taskPublic(task) });
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
  });

  app.post("/api/instances/:id/files/download", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const input = filePathSchema.parse(request.body);
    const transferId = id();
    const token = randomToken(32);
    const transfer: FileTransferRecord = {
      id: transferId,
      instanceId: access.instance.id,
      nodeId: access.instance.nodeId,
      direction: "download",
      path: input.path,
      fileName: basename(input.path),
      storageName: `${transferId}.download`,
      mimeType: "application/octet-stream",
      status: "queued",
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.FILE_TRANSFER_TOKEN_TTL_MINUTES * 60_000).toISOString(),
      createdBy: access.user.id,
      createdAt: now(),
      updatedAt: now()
    };
    await store.transaction((state) => {
      state.fileTransfers.unshift(transfer);
      addAudit(state, access.user!.id, "file.download.queued", `${access.instance!.id}:${input.path}`);
    });
    const task = await enqueue(access.user.id, {
      type: "file.download",
      nodeId: access.instance.nodeId,
      instanceId: access.instance.id,
      payload: { path: input.path, transfer: { id: transfer.id, fileName: transfer.fileName, token } }
    });
    return reply.code(202).send({ transfer: transferPublic(transfer), task: taskPublic(task) });
  });

  app.put("/api/instances/:id/files", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const input = fileSchema.parse(request.body);
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.files[input.path] = input.content;
      const index = target.fileIndex.findIndex((file) => file.path === input.path);
      const record: ManagedFile = { path: input.path, size: Buffer.byteLength(input.content), modifiedAt: now() };
      if (index >= 0) target.fileIndex[index] = record;
      else target.fileIndex.push(record);
      target.updatedAt = now();
      addAudit(state, access.user!.id, "file.write", `${target.id}:${input.path}`);
      return target;
    });
    const task = await enqueue(access.user.id, { type: "file.write", nodeId: instance.nodeId, instanceId: instance.id, payload: input });
    return reply.code(202).send({ task: taskPublic(task) });
  });

  app.post("/api/instances/:id/backups", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.backups");
    if (!access.user || !access.instance) return access.response;
    const input = backupSchema.parse(request.body);
    const backup = await store.transaction((state) => {
      const created = newBackup(access.instance!.id, access.user!.id, input.destination);
      state.backups.unshift(created);
      addAudit(state, access.user!.id, "backup.created", created.id, input.destination);
      return created;
    });
    const task = await enqueue(access.user.id, { type: "instance.backup", nodeId: access.instance.nodeId, instanceId: access.instance.id, payload: { backupId: backup.id, destination: backup.destination, instance: access.instance } });
    return reply.code(202).send({ backup, task: taskPublic(task) });
  });

  app.post("/api/instances/:id/backups/:backupId/restore", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.backups");
    if (!access.user || !access.instance) return access.response;
    const backupId = (request.params as { backupId: string }).backupId;
    const backup = (await store.read()).backups.find((candidate) => candidate.id === backupId && candidate.instanceId === access.instance!.id);
    if (!backup) return notFound(reply, "备份不存在");
    if (backup.status !== "available") return reply.code(409).send({ error: "备份尚不可用于恢复" });
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.status = "starting";
      target.updatedAt = now();
      addAudit(state, access.user!.id, "backup.restore.requested", backup.id, target.id);
      return target;
    });
    const task = await enqueue(access.user.id, { type: "instance.restore", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, backup } });
    return reply.code(202).send({ backup, task: taskPublic(task) });
  });

  app.get("/api/instances/:id/schedules", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.schedules");
    if (!access.user || !access.instance) return access.response;
    const state = await store.read();
    return { schedules: state.schedules.filter((schedule) => schedule.instanceId === access.instance!.id) };
  });

  app.post("/api/instances/:id/schedules", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.schedules");
    if (!access.user || !access.instance) return access.response;
    const input = scheduleSchema.parse(request.body);
    if (!(await canScheduleAction(access.user, access.instance, input.action))) return forbidden(reply);
    let schedule: ScheduleRecord;
    try {
      schedule = newSchedule(access.instance.id, input);
    } catch {
      return reply.code(422).send({ error: "Cron 表达式无效" });
    }
    await store.transaction((state) => {
      state.schedules.unshift(schedule);
      addAudit(state, access.user!.id, "schedule.created", schedule.id, schedule.name);
    });
    return reply.code(201).send({ schedule });
  });

  app.put("/api/instances/:id/schedules/:scheduleId", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.schedules");
    if (!access.user || !access.instance) return access.response;
    const scheduleId = (request.params as { scheduleId: string }).scheduleId;
    const input = scheduleUpdateSchema.parse(request.body);
    if (!(await store.read()).schedules.some((schedule) => schedule.id === scheduleId && schedule.instanceId === access.instance!.id)) return notFound(reply, "计划任务不存在");
    if (!(await canScheduleAction(access.user, access.instance, input.action))) return forbidden(reply);
    let replacement: ScheduleRecord;
    try {
      replacement = newSchedule(access.instance.id, input);
    } catch {
      return reply.code(422).send({ error: "Cron 表达式无效" });
    }
    const schedule = await store.transaction((state) => {
      const target = state.schedules.find((candidate) => candidate.id === scheduleId && candidate.instanceId === access.instance!.id)!;
      target.name = replacement.name;
      target.cron = replacement.cron;
      target.action = replacement.action;
      target.payload = replacement.payload;
      target.enabled = replacement.enabled;
      target.nextRunAt = replacement.nextRunAt;
      addAudit(state, access.user!.id, "schedule.updated", target.id, `${target.action}; ${target.enabled ? "enabled" : "disabled"}`);
      return target;
    });
    return { schedule };
  });

  app.delete("/api/instances/:id/schedules/:scheduleId", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.schedules");
    if (!access.user || !access.instance) return access.response;
    const scheduleId = (request.params as { scheduleId: string }).scheduleId;
    const removed = await store.transaction((state) => {
      const index = state.schedules.findIndex((schedule) => schedule.id === scheduleId && schedule.instanceId === access.instance!.id);
      if (index < 0) return false;
      state.schedules.splice(index, 1);
      addAudit(state, access.user!.id, "schedule.deleted", scheduleId, access.instance!.id);
      return true;
    });
    if (!removed) return notFound(reply, "计划任务不存在");
    return reply.code(204).send();
  });

  app.put("/api/instances/:id/members/:userId", async (request, reply) => {
    const access = await getInstanceManagerAccess(request, reply);
    if (!access.user || !access.instance) return access.response;
    const input = memberSchema.parse(request.body);
    const targetUserId = (request.params as { userId: string }).userId;
    if (targetUserId === access.instance.ownerId) return reply.code(422).send({ error: "实例所有者不需要添加为协作者" });
    if (!(await store.read()).users.some((user) => user.id === targetUserId)) return notFound(reply, "协作者不存在");
    const member = await store.transaction((state) => {
      const existing = state.members.find((candidate) => candidate.instanceId === access.instance!.id && candidate.userId === targetUserId);
      if (existing) {
        existing.permissions = input.permissions;
        addAudit(state, access.user!.id, "instance.member.updated", `${access.instance!.id}:${targetUserId}`, input.permissions.join(","));
        return existing;
      }
      const created = { instanceId: access.instance!.id, userId: targetUserId, permissions: input.permissions };
      state.members.push(created);
      addAudit(state, access.user!.id, "instance.member.added", `${access.instance!.id}:${targetUserId}`, input.permissions.join(","));
      return created;
    });
    return { member };
  });

  app.delete("/api/instances/:id/members/:userId", async (request, reply) => {
    const access = await getInstanceManagerAccess(request, reply);
    if (!access.user || !access.instance) return access.response;
    const targetUserId = (request.params as { userId: string }).userId;
    const removed = await store.transaction((state) => {
      const index = state.members.findIndex((member) => member.instanceId === access.instance!.id && member.userId === targetUserId);
      if (index < 0) return false;
      state.members.splice(index, 1);
      addAudit(state, access.user!.id, "instance.member.removed", `${access.instance!.id}:${targetUserId}`);
      return true;
    });
    if (!removed) return notFound(reply, "协作者不存在");
    return reply.code(204).send();
  });

  app.delete("/api/instances/:id", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.config");
    if (!access.user || !access.instance) return access.response;
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.status = "archived";
      target.archivedAt = now();
      target.archiveExpiresAt = new Date(Date.now() + archiveRetentionMs).toISOString();
      target.updatedAt = now();
      addAudit(state, access.user!.id, "instance.archived", target.id, target.archiveExpiresAt);
      return target;
    });
    const task = await enqueue(access.user.id, { type: "instance.archive", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance } });
    return reply.code(202).send({ task: taskPublic(task), recoverUntil: instance.archiveExpiresAt });
  });

  app.post("/api/instances/:id/restore", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.config");
    if (!access.user || !access.instance) return access.response;
    if (access.instance.status !== "archived" || !access.instance.archiveExpiresAt || new Date(access.instance.archiveExpiresAt).getTime() < Date.now()) return reply.code(409).send({ error: "此实例不在可恢复归档期内" });
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.status = "offline";
      target.archivedAt = undefined;
      target.archiveExpiresAt = undefined;
      target.updatedAt = now();
      addAudit(state, access.user!.id, "instance.restored", target.id);
      return target;
    });
    const task = await enqueue(access.user.id, { type: "instance.restore", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, archiveRestore: true } });
    return reply.code(202).send({ instance: instancePublic(instance), task: taskPublic(task) });
  });

  app.get("/api/tasks", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const state = await store.read();
    const visible = state.instances.filter((instance) => canAccess(state, user, instance, "instance.view"));
    return { tasks: state.tasks.filter((task) => !task.instanceId || visible.some((instance) => instance.id === task.instanceId)).slice(0, 100).map(taskPublic) };
  });

  app.post("/api/tasks/:id/retry", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const taskId = (request.params as { id: string }).id;
    const state = await store.read();
    const failedTask = state.tasks.find((candidate) => candidate.id === taskId);
    if (!failedTask) return notFound(reply, "任务不存在");
    if (failedTask.status !== "failed") return reply.code(409).send({ error: "只有失败任务可以重试" });
    const instance = failedTask.instanceId ? state.instances.find((candidate) => candidate.id === failedTask.instanceId) : undefined;
    if (!instance) return notFound(reply, "任务所属实例不存在");
    const permission = failedTask.type === "instance.command"
      ? "instance.console"
      : failedTask.type === "instance.backup" || failedTask.type === "instance.restore"
        ? "instance.backups"
        : failedTask.type.startsWith("file.")
          ? "instance.files"
          : failedTask.type === "instance.create" || failedTask.type === "instance.archive"
            ? undefined
            : failedTask.type === "instance.restart" && failedTask.payload.applyConfig
              ? "instance.config"
              : "instance.power";
    if (permission ? !canAccess(state, user, instance, permission) : !isAdmin(user) && instance.ownerId !== user.id) return forbidden(reply);
    await store.transaction((draft) => addAudit(draft, user.id, "task.retry.requested", failedTask.id, failedTask.type));
    const task = await enqueue(user.id, { type: failedTask.type, nodeId: failedTask.nodeId, instanceId: failedTask.instanceId, payload: structuredClone(failedTask.payload) });
    return reply.code(202).send({ task: taskPublic(task) });
  });

  app.get("/api/audit", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const state = await store.read();
    return { audits: state.audits.slice(0, 100) };
  });

  app.get("/ws/ui", { websocket: true }, (connection, request) => {
    void getCurrentUser(request).then((user) => {
      const socket = connection as unknown as SocketLike;
      if (!user) return socket.close(4401, "authentication required");
      hub.uiSockets.add(socket);
      socket.on("close", () => hub.uiSockets.delete(socket));
      socket.on("error", () => hub.uiSockets.delete(socket));
    });
  });

  app.get("/ws/agent", { websocket: true }, (connection) => {
    const socket = connection as unknown as SocketLike;
    let nodeId: string | undefined;
    socket.on("message", (raw) => {
      void handleAgentMessage(socket, raw, nodeId).then((next) => { nodeId = next; });
    });
    socket.on("close", () => {
      if (!nodeId || hub.agents.get(nodeId) !== socket) return;
      hub.agents.delete(nodeId);
      const requeuedTaskIds: string[] = [];
      void store.transaction((state) => {
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        if (node) node.online = false;
        for (const task of state.tasks) {
          if (task.nodeId !== nodeId || task.status !== "delivered") continue;
          task.status = "queued";
          task.retryAt = undefined;
          task.message = "节点连接中断，等待重新投递";
          task.updatedAt = now();
          requeuedTaskIds.push(task.id);
        }
      }).then(() => {
        hub.broadcast({ type: "node.updated", nodeId: nodeId!, online: false });
        for (const taskId of requeuedTaskIds) hub.broadcast({ type: "task.updated", taskId, status: "queued", message: "节点连接中断，等待重新投递", progress: 0 });
      });
    });
  });

  const scheduler = setInterval(() => {
    void (async () => {
      const due = await store.transaction((state) => {
        const dueSchedules: Array<{ schedule: ScheduleRecord; instance: InstanceRecord }> = [];
        const retryTaskIds: string[] = [];
        const currentTime = Date.now();
        for (const task of state.tasks) {
          if (task.status === "retrying" && task.retryAt && new Date(task.retryAt).getTime() <= currentTime) {
            task.status = "queued";
            task.retryAt = undefined;
            task.message = `等待第 ${task.attempt + 1}/${MAX_TASK_ATTEMPTS} 次尝试`;
            task.progress = 0;
            task.updatedAt = now();
            retryTaskIds.push(task.id);
            continue;
          }
          if ((task.status !== "running" && task.status !== "delivered") || currentTime - new Date(task.updatedAt).getTime() < TASK_STALE_AFTER_MS) continue;
          if (markTaskForRetry(task, "节点任务执行超时")) {
            addAudit(state, "system", "task.retry.scheduled", task.id, task.message);
            continue;
          }
          task.status = "failed";
          task.retryAt = undefined;
          task.progress = 100;
          task.message = "节点任务执行超时，已停止自动重试";
          task.updatedAt = now();
          const instance = task.instanceId ? state.instances.find((candidate) => candidate.id === task.instanceId) : undefined;
          if (instance) {
            instance.updatedAt = now();
            instance.lastError = task.message;
            if (task.type === "instance.create") instance.status = "error";
          }
          if (task.type === "instance.backup") {
            const backup = state.backups.find((candidate) => candidate.id === String(task.payload.backupId));
            if (backup) backup.status = "failed";
          }
          addAudit(state, "system", "task.failed", task.id, task.message);
        }
        for (const schedule of state.schedules) {
          if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt).getTime() > currentTime) continue;
          const instance = state.instances.find((candidate) => candidate.id === schedule.instanceId && candidate.status !== "archived");
          const next = new Cron(schedule.cron).nextRun();
          schedule.nextRunAt = next?.toISOString();
          if (instance) dueSchedules.push({ schedule, instance });
        }
        const expired = state.instances.filter((instance) => instance.status === "archived" && instance.archiveExpiresAt && new Date(instance.archiveExpiresAt).getTime() <= currentTime);
        for (const instance of expired) addAudit(state, "system", "instance.archive.expired", instance.id);
        const expiredTransferStorage: string[] = [];
        for (const transfer of state.fileTransfers) {
          if (transfer.status === "expired" || new Date(transfer.expiresAt).getTime() > currentTime) continue;
          transfer.status = "expired";
          transfer.updatedAt = now();
          expiredTransferStorage.push(transfer.storageName);
          addAudit(state, "system", "file.transfer.expired", `${transfer.instanceId}:${transfer.path}`);
        }
        return { dueSchedules, expired, expiredTransferStorage, retryTaskIds };
      });
      for (const taskId of due.retryTaskIds) {
        await deliverTask(taskId);
        const task = (await store.read()).tasks.find((candidate) => candidate.id === taskId);
        if (task) hub.broadcast({ type: "task.updated", taskId, status: task.status, message: task.message, progress: task.progress, retryAt: task.retryAt, attempt: task.attempt });
      }
      for (const { schedule, instance } of due.dueSchedules) {
        const type: TaskType = schedule.action === "backup" ? "instance.backup" : schedule.action === "restart" ? "instance.restart" : "instance.command";
        const destination = schedule.action === "backup" && schedule.payload.destination === "s3" ? "s3" : "local";
        const backup = schedule.action === "backup" ? await store.transaction((state) => { const created = newBackup(instance.id, "system", destination); state.backups.unshift(created); return created; }) : undefined;
        await enqueue("system", { type, nodeId: instance.nodeId, instanceId: instance.id, payload: schedule.action === "backup" ? { backupId: backup!.id, destination: backup!.destination, instance } : schedule.action === "restart" ? { instance } : schedule.payload });
      }
      for (const instance of due.expired) await enqueue("system", { type: "instance.archive", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, purge: true } });
      await Promise.all(due.expiredTransferStorage.map((storageName) => rm(getTransferFilePath(storageName), { force: true })));
    })();
  }, 10_000);
  scheduler.unref();

  app.addHook("onClose", async () => {
    clearInterval(scheduler);
    await store.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(422).send({ error: "请求参数无效", details: error.flatten() });
    const message = error instanceof Error ? error.message : "未知错误";
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) return reply.code(statusCode).send({ error: message });
    if (message === "节点不存在" || message === "协作者不存在") return reply.code(404).send({ error: message });
    if (message.includes("端口") || message.includes("同名") || message.includes("已存在")) return reply.code(409).send({ error: message });
    app.log.error(error);
    return reply.code(500).send({ error: "服务器处理请求时出现错误" });
  });

  return app;
}

const main = async () => {
  const app = await buildServer();
  const config = loadConfig();
  await app.listen({ host: config.HOST, port: config.PORT });
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
