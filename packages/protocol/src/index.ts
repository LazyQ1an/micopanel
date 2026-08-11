export const SERVER_KINDS = ["vanilla", "paper", "fabric", "forge", "bedrock", "custom"] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export const TASK_TYPES = [
  "instance.create",
  "instance.start",
  "instance.stop",
  "instance.restart",
  "instance.kill",
  "instance.command",
  "instance.backup",
  "instance.restore",
  "instance.archive",
  "file.list",
  "file.read",
  "file.write",
  "file.upload",
  "file.download"
] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export type TaskStatus = "queued" | "delivered" | "running" | "succeeded" | "failed" | "cancelled";

export type Permission =
  | "instance.view"
  | "instance.console"
  | "instance.power"
  | "instance.files"
  | "instance.config"
  | "instance.backups"
  | "instance.schedules";

export const ALL_INSTANCE_PERMISSIONS = [
  "instance.view",
  "instance.console",
  "instance.power",
  "instance.files",
  "instance.config",
  "instance.backups",
  "instance.schedules"
] as const satisfies readonly Permission[];

export interface ResourceLimits {
  memoryMb: number;
  cpuCores: number;
  pids: number;
  diskMb: number;
}

export interface PortBinding {
  host: number;
  container: number;
  protocol: "tcp" | "udp";
}

export interface InstanceSpec {
  id: string;
  name: string;
  nodeId: string;
  kind: ServerKind;
  version: string;
  image: string;
  status: "creating" | "offline" | "starting" | "running" | "stopping" | "archived" | "error";
  limits: ResourceLimits;
  ports: PortBinding[];
  environment: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  type: TaskType;
  instanceId?: string;
  payload: Record<string, unknown>;
  attempt: number;
}

export type AgentInboundMessage =
  | { type: "register"; token: string; nodeName: string; agentVersion: string; capabilities: string[] }
  | { type: "authenticate"; nodeId: string; certificate: string; agentVersion: string; capabilities: string[] }
  | { type: "heartbeat"; usage: NodeUsage }
  | { type: "task.ack"; taskId: string }
  | { type: "task.progress"; taskId: string; message: string; progress?: number }
  | { type: "task.result"; taskId: string; ok: boolean; message?: string; data?: Record<string, unknown> }
  | { type: "console.output"; instanceId: string; line: string }
  | { type: "instance.state"; instanceId: string; status: InstanceSpec["status"] };

export type AgentOutboundMessage =
  | { type: "registered"; nodeId: string; certificate: string }
  | { type: "task"; task: AgentTask }
  | { type: "error"; message: string };

export interface NodeUsage {
  cpuCores: number;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  diskBytes: number;
  diskLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export type UiEvent =
  | { type: "node.updated"; nodeId: string; usage?: NodeUsage; online?: boolean }
  | { type: "instance.updated"; instanceId: string; status: InstanceSpec["status"] }
  | { type: "console.output"; instanceId: string; line: string }
  | { type: "task.updated"; taskId: string; status: TaskStatus; message?: string; progress?: number };
