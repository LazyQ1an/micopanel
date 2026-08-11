import type { InstanceSpec, NodeUsage, Permission, TaskStatus, TaskType } from "@micopanel/protocol";

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export interface NodeRecord {
  id: string;
  name: string;
  enrollmentTokenHash?: string;
  agentCredentialHash?: string;
  agentVersion?: string;
  capabilities: string[];
  online: boolean;
  lastSeenAt?: string;
  usage?: NodeUsage;
  portRangeStart: number;
  portRangeEnd: number;
  createdAt: string;
}

export interface InstanceRecord extends InstanceSpec {
  ownerId: string;
  archivedAt?: string;
  archiveExpiresAt?: string;
  lastError?: string;
  console: string[];
  files: Record<string, string>;
}

export interface InstanceMember {
  instanceId: string;
  userId: string;
  permissions: Permission[];
}

export interface TaskRecord {
  id: string;
  type: TaskType;
  nodeId: string;
  instanceId?: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  attempt: number;
  message?: string;
  progress?: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRecord {
  id: string;
  instanceId: string;
  name: string;
  destination: "local" | "s3";
  sizeBytes?: number;
  checksum?: string;
  status: "queued" | "creating" | "available" | "failed";
  createdAt: string;
}

export interface ScheduleRecord {
  id: string;
  instanceId: string;
  name: string;
  cron: string;
  action: "command" | "backup" | "restart";
  payload: Record<string, unknown>;
  enabled: boolean;
  nextRunAt?: string;
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  target: string;
  detail?: string;
  createdAt: string;
}

export interface PanelState {
  users: User[];
  sessions: Session[];
  nodes: NodeRecord[];
  instances: InstanceRecord[];
  members: InstanceMember[];
  tasks: TaskRecord[];
  backups: BackupRecord[];
  schedules: ScheduleRecord[];
  audits: AuditRecord[];
}

export const createEmptyState = (): PanelState => ({
  users: [],
  sessions: [],
  nodes: [],
  instances: [],
  members: [],
  tasks: [],
  backups: [],
  schedules: [],
  audits: []
});

