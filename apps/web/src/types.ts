import type { Permission, ServerKind, TaskStatus } from "@micopanel/protocol";

export interface User {
  id: string;
  username: string;
  role: "admin" | "user";
}

export interface Node {
  id: string;
  name: string;
  online: boolean;
  agentVersion?: string;
  capabilities: string[];
  portRangeStart: number;
  portRangeEnd: number;
  lastSeenAt?: string;
  usage?: { cpuCores: number; cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; diskBytes: number; diskLimitBytes: number };
}

export interface Instance {
  id: string;
  name: string;
  nodeId: string;
  kind: ServerKind;
  version: string;
  image: string;
  status: "creating" | "offline" | "starting" | "running" | "stopping" | "archived" | "error";
  limits: { memoryMb: number; cpuCores: number; pids: number; diskMb: number };
  ports: Array<{ host: number; container: number; protocol: "tcp" | "udp" }>;
  environment: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  archiveExpiresAt?: string;
  lastError?: string;
}

export interface Task {
  id: string;
  type: string;
  nodeId: string;
  instanceId?: string;
  status: TaskStatus;
  attempt: number;
  message?: string;
  progress?: number;
  retryAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Backup {
  id: string;
  instanceId: string;
  name: string;
  destination: "local" | "s3";
  sizeBytes?: number;
  checksum?: string;
  status: "queued" | "creating" | "available" | "failed";
  createdAt: string;
}

export interface Schedule {
  id: string;
  instanceId: string;
  name: string;
  cron: string;
  action: "command" | "backup" | "restart";
  payload: Record<string, unknown>;
  enabled: boolean;
  nextRunAt?: string;
}

export interface MetricPoint {
  capturedAt: string;
  cpuPercent: number;
  memoryBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  diskBytes?: number;
  diskLimitBytes?: number;
  pids?: number;
}

export interface FileTransfer {
  id: string;
  instanceId: string;
  direction: "upload" | "download";
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  checksum?: string;
  status: "queued" | "receiving" | "available" | "failed" | "expired";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface InstanceMember {
  instanceId: string;
  userId: string;
  permissions: Permission[];
  user: User;
}

export interface MemberDirectory {
  owner: User;
  members: InstanceMember[];
  users: User[];
  canManage: boolean;
  canCreateUsers: boolean;
}

export interface Dashboard {
  instances: Instance[];
  nodes: Node[];
  tasks: Task[];
  backups: Backup[];
  summary: { onlineNodes: number; totalNodes: number; runningInstances: number; totalInstances: number; queuedTasks: number };
}

export interface InstanceDetail {
  instance: Instance;
  configuration: { environment: Record<string, string>; managedEnvironment: Record<string, string> };
  console: string[];
  files: Array<{ path: string; size: number; modifiedAt: string; content?: string }>;
  backups: Backup[];
  schedules: Schedule[];
  members: Array<{ instanceId: string; userId: string; permissions: Permission[] }>;
}
