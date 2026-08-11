import type { Permission, ResourceLimits, ServerKind, TaskType } from "@micopanel/protocol";
import { ALL_INSTANCE_PERMISSIONS } from "@micopanel/protocol";
import { getTemplate } from "./templates.js";
import { Cron } from "croner";
import { hashToken, id, randomToken } from "./security.js";
import type {
  AuditRecord,
  BackupRecord,
  InstanceMember,
  InstanceRecord,
  NodeRecord,
  PanelState,
  ScheduleRecord,
  TaskRecord,
  User,
  UserRole
} from "./types.js";
import type { StateStore } from "./store.js";

const now = (): string => new Date().toISOString();

export const MANAGED_ENVIRONMENT_KEYS = new Set(["EULA", "TYPE", "VERSION", "MEMORY", "CUSTOM_JAR"]);

export interface InstanceConfigurationInput {
  environment: Record<string, string>;
  limits: ResourceLimits;
  port: number;
  version: string;
}

export const findUser = (state: PanelState, userId: string): User | undefined => state.users.find((user) => user.id === userId);

export const isAdmin = (user: User): boolean => user.role === "admin";

export const canAccess = (state: PanelState, user: User, instance: InstanceRecord, permission: Permission): boolean => {
  if (isAdmin(user) || instance.ownerId === user.id) return true;
  const member = state.members.find((candidate) => candidate.instanceId === instance.id && candidate.userId === user.id);
  return Boolean(member?.permissions.includes(permission));
};

export const addAudit = (state: PanelState, actorId: string, action: string, target: string, detail?: string): AuditRecord => {
  const record = { id: id(), actorId, action, target, detail, createdAt: now() };
  state.audits.unshift(record);
  state.audits = state.audits.slice(0, 2000);
  return record;
};

export const createAdminIfNeeded = async (store: StateStore, username: string, passwordHash: string): Promise<boolean> =>
  store.transaction((state) => {
    if (state.users.length > 0) return false;
    state.users.push({ id: id(), username, passwordHash, role: "admin", createdAt: now() });
    return true;
  });

export const createNode = async (
  store: StateStore,
  actorId: string,
  input: { name: string; portRangeStart: number; portRangeEnd: number }
): Promise<{ node: NodeRecord; enrollmentToken: string }> => {
  const enrollmentToken = randomToken(24);
  const node: NodeRecord = {
    id: id(),
    name: input.name.trim(),
    enrollmentTokenHash: hashToken(enrollmentToken),
    capabilities: [],
    online: false,
    portRangeStart: input.portRangeStart,
    portRangeEnd: input.portRangeEnd,
    createdAt: now()
  };
  await store.transaction((state) => {
    state.nodes.push(node);
    addAudit(state, actorId, "node.created", node.id, node.name);
  });
  return { node, enrollmentToken };
};

export const allocatePort = (
  state: PanelState,
  node: NodeRecord,
  protocol: "tcp" | "udp",
  requested?: number,
  excludeInstanceId?: string
): number => {
  const used = new Set(
    state.instances
      .filter((instance) => instance.nodeId === node.id && instance.status !== "archived" && instance.id !== excludeInstanceId)
      .flatMap((instance) => instance.ports.filter((port) => port.protocol === protocol).map((port) => port.host))
  );
  if (requested !== undefined) {
    if (requested < node.portRangeStart || requested > node.portRangeEnd) throw new Error("端口不在节点可分配范围内");
    if (used.has(requested)) throw new Error("端口已被当前节点上的其他实例占用");
    return requested;
  }
  for (let port = node.portRangeStart; port <= node.portRangeEnd; port += 1) {
    if (!used.has(port)) return port;
  }
  throw new Error("节点没有可用端口");
};

export const managedEnvironment = (instance: Pick<InstanceRecord, "kind" | "environment">): Record<string, string> => {
  const environment = { ...getTemplate(instance.kind).environment };
  if (instance.kind === "custom" && instance.environment.CUSTOM_JAR) environment.CUSTOM_JAR = instance.environment.CUSTOM_JAR;
  return environment;
};

export const configurableEnvironment = (instance: Pick<InstanceRecord, "kind" | "environment">): Record<string, string> => {
  const locked = new Set(Object.keys(managedEnvironment(instance)));
  for (const key of MANAGED_ENVIRONMENT_KEYS) locked.add(key);
  return Object.fromEntries(Object.entries(instance.environment).filter(([key]) => !locked.has(key)));
};

export const createInstance = async (
  store: StateStore,
  actorId: string,
  input: {
    name: string;
    nodeId: string;
    kind: ServerKind;
    version: string;
    memoryMb: number;
    cpuCores: number;
    diskMb: number;
    pids: number;
    port?: number;
    environment?: Record<string, string>;
    customJar?: string;
  }
): Promise<InstanceRecord> => {
  const template = getTemplate(input.kind);
  if (Object.keys(input.environment ?? {}).some((key) => MANAGED_ENVIRONMENT_KEYS.has(key))) throw new Error("不能修改受管环境变量");
  return store.transaction((state) => {
    const node = state.nodes.find((candidate) => candidate.id === input.nodeId);
    if (!node) throw new Error("节点不存在");
    if (state.instances.some((instance) => instance.name.toLowerCase() === input.name.trim().toLowerCase() && instance.nodeId === node.id && instance.status !== "archived")) {
      throw new Error("该节点上已经存在同名实例");
    }
    const instance: InstanceRecord = {
      id: id(),
      name: input.name.trim(),
      nodeId: node.id,
      kind: input.kind,
      version: input.version.trim(),
      image: template.image,
      status: "creating",
      limits: { memoryMb: input.memoryMb, cpuCores: input.cpuCores, diskMb: input.diskMb, pids: input.pids },
      ports: [{ host: allocatePort(state, node, template.protocol, input.port), container: template.defaultPort, protocol: template.protocol }],
      environment: { ...template.environment, ...(input.environment ?? {}), ...(input.customJar ? { CUSTOM_JAR: input.customJar } : {}) },
      ownerId: actorId,
      console: [],
      files: {},
      fileIndex: [],
      createdAt: now(),
      updatedAt: now()
    };
    state.instances.push(instance);
    addAudit(state, actorId, "instance.created", instance.id, instance.name);
    return instance;
  });
};

export const updateInstanceConfiguration = async (
  store: StateStore,
  actorId: string,
  instanceId: string,
  input: InstanceConfigurationInput
): Promise<InstanceRecord> =>
  store.transaction((state) => {
    const instance = state.instances.find((candidate) => candidate.id === instanceId);
    if (!instance) throw new Error("实例不存在");
    const node = state.nodes.find((candidate) => candidate.id === instance.nodeId);
    if (!node) throw new Error("节点不存在");
    const template = getTemplate(instance.kind);
    const existingPort = instance.ports[0];
    const protocol = existingPort?.protocol ?? template.protocol;
    const container = existingPort?.container ?? template.defaultPort;
    instance.environment = { ...managedEnvironment(instance), ...input.environment };
    instance.limits = input.limits;
    instance.version = input.version.trim();
    instance.ports = [{ host: allocatePort(state, node, protocol, input.port, instance.id), container, protocol }];
    instance.updatedAt = now();
    addAudit(state, actorId, "instance.config.updated", instance.id, `port=${instance.ports[0].host}; memoryMb=${instance.limits.memoryMb}; cpuCores=${instance.limits.cpuCores}`);
    return instance;
  });

export const createTask = async (
  store: StateStore,
  actorId: string,
  input: { type: TaskType; nodeId: string; instanceId?: string; payload?: Record<string, unknown> }
): Promise<TaskRecord> => {
  const task: TaskRecord = {
    id: id(),
    type: input.type,
    nodeId: input.nodeId,
    instanceId: input.instanceId,
    payload: input.payload ?? {},
    status: "queued",
    attempt: 0,
    createdBy: actorId,
    createdAt: now(),
    updatedAt: now()
  };
  await store.transaction((state) => {
    state.tasks.unshift(task);
    addAudit(state, actorId, `task.${input.type}`, input.instanceId ?? input.nodeId);
  });
  return task;
};

export const taskPublic = (task: TaskRecord) => ({
  id: task.id,
  type: task.type,
  nodeId: task.nodeId,
  instanceId: task.instanceId,
  status: task.status,
  attempt: task.attempt,
  message: task.message,
  progress: task.progress,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt
});

export const instancePublic = (instance: InstanceRecord) => {
  const { ownerId: _ownerId, console: _console, files: _files, ...safe } = instance;
  return safe;
};

export const nodePublic = (node: NodeRecord) => {
  const { enrollmentTokenHash: _enrollmentTokenHash, agentCredentialHash: _agentCredentialHash, ...safe } = node;
  return safe;
};

export const allPermissions = (): Permission[] => [...ALL_INSTANCE_PERMISSIONS];

export const newBackup = (instanceId: string, actorId: string, destination: "local" | "s3"): BackupRecord => ({
  id: id(),
  instanceId,
  name: `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  destination,
  status: "queued",
  createdAt: now()
});

export const newSchedule = (instanceId: string, input: { name: string; cron: string; action: ScheduleRecord["action"]; payload: Record<string, unknown>; enabled?: boolean }): ScheduleRecord => {
  const nextRun = new Cron(input.cron.trim()).nextRun();
  return {
    id: id(),
    instanceId,
    name: input.name.trim(),
    cron: input.cron.trim(),
    action: input.action,
    payload: input.payload,
    enabled: input.enabled ?? true,
    nextRunAt: input.enabled === false ? undefined : nextRun?.toISOString(),
    createdAt: now()
  };
};

export const roleForNewUser = (role: unknown): UserRole => role === "admin" ? "admin" : "user";
