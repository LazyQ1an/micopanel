import type { InstanceSpec, NodeUsage, Permission, TaskStatus, TaskType } from "@micopanel/protocol";

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

export type UserRole = "admin" | "user";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  totpSecret?: string;
  totpEnabled?: boolean;
  recoveryCodes?: string[];
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
  fileIndex: ManagedFile[];
}

export interface ManagedFile {
  path: string;
  size: number;
  modifiedAt: string;
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
  retryAt?: string;
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
  ip?: string;
  userAgent?: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: string;
  fileName: string;
  storageName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  createdBy: string;
  createdAt: string;
  downloadTokenHash?: string;
  tokenExpiresAt?: string;
}

export interface FileTransferRecord {
  id: string;
  instanceId: string;
  nodeId: string;
  direction: "upload" | "download";
  path: string;
  fileName: string;
  storageName: string;
  mimeType: string;
  sizeBytes?: number;
  checksum?: string;
  status: "queued" | "receiving" | "available" | "failed" | "expired";
  tokenHash: string;
  expiresAt: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type AlertScope = "node" | "instance";
export interface AlertTargetSample {
  scope: AlertScope;
  id: string;
  name: string;
  cpuPercent?: number;
  memoryPercent?: number;
  diskPercent?: number;
  online: boolean;
  offlineSeconds?: number;
}
export type AlertMetric = "cpu" | "memory" | "disk" | "offline";
export type AlertLevel = "warning" | "critical";
export type AlertStatus = "firing" | "resolved";
export type NotificationChannelType = "webhook" | "dingtalk" | "wecom" | "serverchan";

export interface AlertRule {
  id: string;
  name: string;
  scope: AlertScope;
  targetId?: string;
  metric: AlertMetric;
  threshold: number;
  level: AlertLevel;
  channelIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  url: string;
  secret?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  scope: AlertScope;
  targetId: string;
  targetName: string;
  metric: AlertMetric;
  level: AlertLevel;
  value: number;
  threshold: number;
  status: AlertStatus;
  firedAt: string;
  resolvedAt?: string;
}

export interface ApiTokenRecord {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface PanelState {
  alertRules: AlertRule[];
  alertEvents: AlertEvent[];
  notificationChannels: NotificationChannel[];
  users: User[];
  sessions: Session[];
  apiTokens: ApiTokenRecord[];
  nodes: NodeRecord[];
  instances: InstanceRecord[];
  members: InstanceMember[];
  tasks: TaskRecord[];
  backups: BackupRecord[];
  schedules: ScheduleRecord[];
  audits: AuditRecord[];
  artifacts: ArtifactRecord[];
  fileTransfers: FileTransferRecord[];
}

export const createEmptyState = (): PanelState => ({
  alertRules: [],
  alertEvents: [],
  notificationChannels: [],
  users: [],
  sessions: [],
  apiTokens: [],
  nodes: [],
  instances: [],
  members: [],
  tasks: [],
  backups: [],
  schedules: [],
  audits: [],
  artifacts: [],
  fileTransfers: []
});
