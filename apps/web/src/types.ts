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
  usage?: { cpuPercent: number; memoryBytes: number; memoryLimitBytes: number; diskBytes: number; diskLimitBytes: number };
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

export interface Dashboard {
  instances: Instance[];
  nodes: Node[];
  tasks: Task[];
  backups: Backup[];
  summary: { onlineNodes: number; totalNodes: number; runningInstances: number; totalInstances: number; queuedTasks: number };
}

export interface InstanceDetail {
  instance: Instance;
  console: string[];
  backups: Backup[];
  schedules: Schedule[];
  members: Array<{ instanceId: string; userId: string; permissions: Permission[] }>;
}

