import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
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
  findUser,
  instancePublic,
  isAdmin,
  newBackup,
  newSchedule,
  nodePublic,
  roleForNewUser,
  taskPublic
} from "./service.js";
import { createStore, type StateStore } from "./store.js";
import { SERVER_TEMPLATES } from "./templates.js";
import type { BackupRecord, InstanceRecord, NodeRecord, ScheduleRecord, TaskRecord, User } from "./types.js";

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
  environment: z.record(z.string().max(128)).default({}),
  eulaAccepted: z.literal(true)
});
const actionSchema = z.object({ action: z.enum(["start", "stop", "restart", "kill", "command"]), command: z.string().min(1).max(2000).optional() });
const backupSchema = z.object({ destination: z.enum(["local", "s3"]).default("local") });
const scheduleSchema = z.object({
  name: z.string().min(2).max(64),
  cron: z.string().min(9).max(128),
  action: z.enum(["command", "backup", "restart"]),
  payload: z.record(z.unknown()).default({})
});
const memberSchema = z.object({ permissions: z.array(z.enum(ALL_INSTANCE_PERMISSIONS)).min(1) });
const userSchema = z.object({ username: z.string().min(3).max(32), password: z.string().min(10).max(128), role: z.enum(["admin", "user"]).default("user") });
const fileSchema = z.object({ path: z.string().min(1).max(512).refine((path) => !path.includes("..") && path.startsWith("/"), "文件路径无效"), content: z.string().max(10_000_000) });

export async function buildServer(options?: { config?: AppConfig; store?: StateStore }) {
  const config = options?.config ?? loadConfig();
  const store = options?.store ?? createStore(config.DATABASE_URL);
  await store.init();

  const app = Fastify({ logger: config.NODE_ENV !== "test", bodyLimit: 10_500_000, trustProxy: config.NODE_ENV === "production" });
  const hub = new RealtimeHub();
  await app.register(cookie, { secret: config.SESSION_SECRET, hook: "onRequest" });
  await app.register(cors, { origin: config.CORS_ORIGIN, credentials: true });
  await app.register(rateLimit, { global: true, max: 180, timeWindow: "1 minute", skipOnError: true });
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

  const deliverTask = async (taskId: string): Promise<void> => {
    const snapshot = await store.read();
    const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
    if (!task || task.status !== "queued") return;
    const agentTask: AgentTask = { id: task.id, type: task.type, instanceId: task.instanceId, payload: task.payload, attempt: task.attempt };
    if (!hub.sendAgent(task.nodeId, { type: "task", task: agentTask })) return;
    await store.transaction((state) => {
      const target = state.tasks.find((candidate) => candidate.id === taskId);
      if (!target || target.status !== "queued") return;
      target.status = "delivered";
      target.attempt += 1;
      target.updatedAt = now();
    });
    hub.broadcast({ type: "task.updated", taskId, status: "delivered" });
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

  const agentTaskResult = async (message: Extract<AgentInboundMessage, { type: "task.result" }>): Promise<void> => {
    let status: "succeeded" | "failed" = message.ok ? "succeeded" : "failed";
    let instanceId: string | undefined;
    await store.transaction((state) => {
      const task = state.tasks.find((candidate) => candidate.id === message.taskId);
      if (!task) return;
      task.status = status;
      task.message = message.message;
      task.progress = 100;
      task.updatedAt = now();
      instanceId = task.instanceId;
      const instance = task.instanceId ? state.instances.find((candidate) => candidate.id === task.instanceId) : undefined;
      if (instance) {
        instance.updatedAt = now();
        if (!message.ok) {
          instance.lastError = message.message ?? "Agent task failed";
          if (task.type === "instance.create") instance.status = "error";
        } else if (task.type === "instance.create" || task.type === "instance.stop" || task.type === "instance.kill") {
          instance.status = "offline";
        } else if (task.type === "instance.start" || task.type === "instance.restart") {
          instance.status = "running";
        } else if (task.type === "instance.archive") {
          instance.status = "archived";
        }
      }
      if (task.type === "instance.backup") {
        const backup = state.backups.find((candidate) => candidate.id === String(task.payload.backupId));
        if (backup) {
          backup.status = message.ok ? "available" : "failed";
          backup.sizeBytes = Number(message.data?.sizeBytes) || undefined;
          backup.checksum = typeof message.data?.checksum === "string" ? message.data.checksum : undefined;
        }
      }
      addAudit(state, "agent", message.ok ? "task.succeeded" : "task.failed", task.id, message.message);
    });
    hub.broadcast({ type: "task.updated", taskId: message.taskId, status, message: message.message, progress: 100 });
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
      await agentTaskResult(message);
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

  app.post("/api/nodes", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    if (!isAdmin(user)) return forbidden(reply);
    const input = nodeSchema.parse(request.body);
    const result = await createNode(store, user.id, input);
    return reply.code(201).send({ node: nodePublic(result.node), enrollmentToken: result.enrollmentToken });
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
    const instance = await createInstance(store, user.id, input);
    const task = await enqueue(user.id, { type: "instance.create", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance } });
    return reply.code(202).send({ instance: instancePublic(instance), task: taskPublic(task) });
  });

  app.get("/api/instances/:id", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.view");
    if (!access.user || !access.instance) return access.response;
    const state = await store.read();
    return {
      instance: instancePublic(access.instance),
      members: state.members.filter((member) => member.instanceId === access.instance!.id),
      console: access.instance.console,
      backups: state.backups.filter((backup) => backup.instanceId === access.instance!.id),
      schedules: state.schedules.filter((schedule) => schedule.instanceId === access.instance!.id)
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
    const input = z.object({ environment: z.record(z.string().max(128)), limits: z.object({ memoryMb: z.number().int().min(512), cpuCores: z.number().min(0.25), diskMb: z.number().int().min(1024), pids: z.number().int().min(64) }) }).parse(request.body);
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.environment = input.environment;
      target.limits = input.limits;
      target.updatedAt = now();
      addAudit(state, access.user!.id, "instance.config.updated", target.id);
      return target;
    });
    const task = await enqueue(access.user.id, { type: "instance.restart", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, applyConfig: true } });
    return reply.code(202).send({ instance: instancePublic(instance), task: taskPublic(task) });
  });

  app.get("/api/instances/:id/files", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const path = typeof (request.query as { path?: string }).path === "string" ? (request.query as { path: string }).path : "/";
    const files = Object.entries(access.instance.files).filter(([filePath]) => filePath.startsWith(path)).map(([filePath, content]) => ({ path: filePath, size: Buffer.byteLength(content), content }));
    return { files };
  });

  app.put("/api/instances/:id/files", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.files");
    if (!access.user || !access.instance) return access.response;
    const input = fileSchema.parse(request.body);
    const instance = await store.transaction((state) => {
      const target = state.instances.find((candidate) => candidate.id === access.instance!.id)!;
      target.files[input.path] = input.content;
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

  app.put("/api/instances/:id/members/:userId", async (request, reply) => {
    const access = await getInstanceAccess(request, reply, "instance.config");
    if (!access.user || !access.instance) return access.response;
    const input = memberSchema.parse(request.body);
    const targetUserId = (request.params as { userId: string }).userId;
    const member = await store.transaction((state) => {
      if (!state.users.some((user) => user.id === targetUserId)) throw new Error("协作者不存在");
      const existing = state.members.find((candidate) => candidate.instanceId === access.instance!.id && candidate.userId === targetUserId);
      if (existing) {
        existing.permissions = input.permissions;
        return existing;
      }
      const created = { instanceId: access.instance!.id, userId: targetUserId, permissions: input.permissions };
      state.members.push(created);
      addAudit(state, access.user!.id, "instance.member.updated", `${access.instance!.id}:${targetUserId}`);
      return created;
    });
    return { member };
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
    const task = await enqueue(access.user.id, { type: "instance.restore", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance } });
    return reply.code(202).send({ instance: instancePublic(instance), task: taskPublic(task) });
  });

  app.get("/api/tasks", async (request, reply) => {
    const user = await getCurrentUser(request);
    if (!user) return unauthenticated(reply);
    const state = await store.read();
    const visible = state.instances.filter((instance) => canAccess(state, user, instance, "instance.view"));
    return { tasks: state.tasks.filter((task) => !task.instanceId || visible.some((instance) => instance.id === task.instanceId)).slice(0, 100).map(taskPublic) };
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
      void store.transaction((state) => {
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        if (node) node.online = false;
      }).then(() => hub.broadcast({ type: "node.updated", nodeId: nodeId!, online: false }));
    });
  });

  const scheduler = setInterval(() => {
    void (async () => {
      const due = await store.transaction((state) => {
        const dueSchedules: Array<{ schedule: ScheduleRecord; instance: InstanceRecord }> = [];
        const currentTime = Date.now();
        for (const schedule of state.schedules) {
          if (!schedule.enabled || !schedule.nextRunAt || new Date(schedule.nextRunAt).getTime() > currentTime) continue;
          const instance = state.instances.find((candidate) => candidate.id === schedule.instanceId && candidate.status !== "archived");
          const next = new Cron(schedule.cron).nextRun();
          schedule.nextRunAt = next?.toISOString();
          if (instance) dueSchedules.push({ schedule, instance });
        }
        const expired = state.instances.filter((instance) => instance.status === "archived" && instance.archiveExpiresAt && new Date(instance.archiveExpiresAt).getTime() <= currentTime);
        for (const instance of expired) addAudit(state, "system", "instance.archive.expired", instance.id);
        return { dueSchedules, expired };
      });
      for (const { schedule, instance } of due.dueSchedules) {
        const type: TaskType = schedule.action === "backup" ? "instance.backup" : schedule.action === "restart" ? "instance.restart" : "instance.command";
        const backup = schedule.action === "backup" ? await store.transaction((state) => { const created = newBackup(instance.id, "system", "local"); state.backups.unshift(created); return created; }) : undefined;
        await enqueue("system", { type, nodeId: instance.nodeId, instanceId: instance.id, payload: schedule.action === "backup" ? { backupId: backup!.id, destination: "local", instance } : schedule.action === "restart" ? { instance } : schedule.payload });
      }
      for (const instance of due.expired) await enqueue("system", { type: "instance.archive", nodeId: instance.nodeId, instanceId: instance.id, payload: { instance, purge: true } });
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
