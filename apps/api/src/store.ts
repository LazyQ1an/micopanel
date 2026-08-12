import { Pool } from "pg";
import { createEmptyState, type MetricPoint, type PanelState } from "./types.js";

export type MetricScope = "node" | "instance";

export interface MetricBatch {
  nodeId: string;
  capturedAt: string;
  node: MetricPoint;
  instances: Array<{ instanceId: string; point: MetricPoint }>;
}

export interface StateStore {
  init(): Promise<void>;
  read(): Promise<PanelState>;
  transaction<T>(fn: (state: PanelState) => T | Promise<T>): Promise<T>;
  appendMetrics(batch: MetricBatch): Promise<void>;
  getMetrics(scope: MetricScope, entityId: string, since: Date): Promise<MetricPoint[]>;
  close(): Promise<void>;
}

const clone = (state: PanelState): PanelState => structuredClone(state);

const normalizeState = (state: PanelState): PanelState => {
  for (const instance of state.instances) {
    instance.console ??= [];
    instance.files ??= {};
    instance.fileIndex ??= [];
  }
  state.artifacts ??= [];
  state.fileTransfers ??= [];
  return state;
};

export class MemoryStore implements StateStore {
  private state = createEmptyState();
  private chain = Promise.resolve();
  private readonly metrics = new Map<string, MetricPoint[]>();

  async init(): Promise<void> {}
  async read(): Promise<PanelState> {
    await this.chain;
    return clone(this.state);
  }
  async transaction<T>(fn: (state: PanelState) => T | Promise<T>): Promise<T> {
    const operation = this.chain.then(async () => {
      const draft = clone(this.state);
      const result = await fn(draft);
      this.state = draft;
      return result;
    });
    this.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async appendMetrics(batch: MetricBatch): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const append = (scope: MetricScope, entityId: string, point: MetricPoint) => {
      const key = `${scope}:${entityId}`;
      const points = this.metrics.get(key) ?? [];
      const next = [...points.filter((candidate) => new Date(candidate.capturedAt).getTime() >= cutoff && candidate.capturedAt !== point.capturedAt), structuredClone(point)];
      this.metrics.set(key, next.slice(-2_880));
    };
    append("node", batch.nodeId, batch.node);
    for (const instance of batch.instances) append("instance", instance.instanceId, instance.point);
  }
  async getMetrics(scope: MetricScope, entityId: string, since: Date): Promise<MetricPoint[]> {
    const points = this.metrics.get(`${scope}:${entityId}`) ?? [];
    return points.filter((point) => new Date(point.capturedAt).getTime() >= since.getTime()).map((point) => structuredClone(point));
  }
  async close(): Promise<void> {}
}

export class PostgresStateStore implements StateStore {
  private readonly pool: Pool;
  private state = createEmptyState();
  private chain = Promise.resolve();
  private lastMetricPruneAt = 0;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 8 });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS panel_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        state JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS metric_points (
        scope TEXT NOT NULL CHECK (scope IN ('node', 'instance')),
        entity_id UUID NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL,
        cpu_percent REAL NOT NULL,
        memory_bytes BIGINT NOT NULL,
        memory_limit_bytes BIGINT NOT NULL,
        network_rx_bytes BIGINT NOT NULL,
        network_tx_bytes BIGINT NOT NULL,
        disk_bytes BIGINT,
        disk_limit_bytes BIGINT,
        pids INTEGER,
        PRIMARY KEY (scope, entity_id, captured_at)
      )
    `);
    await this.pool.query("ALTER TABLE metric_points ADD COLUMN IF NOT EXISTS disk_bytes BIGINT");
    await this.pool.query("ALTER TABLE metric_points ADD COLUMN IF NOT EXISTS disk_limit_bytes BIGINT");
    await this.pool.query("CREATE INDEX IF NOT EXISTS metric_points_entity_time_idx ON metric_points (scope, entity_id, captured_at DESC)");
    const result = await this.pool.query<{ state: PanelState }>("SELECT state FROM panel_state WHERE id = 1");
    if (result.rowCount) {
      this.state = normalizeState(result.rows[0].state);
      await this.pool.query("UPDATE panel_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(this.state)]);
      return;
    }
    await this.pool.query("INSERT INTO panel_state (id, state) VALUES (1, $1::jsonb)", [JSON.stringify(this.state)]);
  }

  async read(): Promise<PanelState> {
    await this.chain;
    return clone(this.state);
  }

  async transaction<T>(fn: (state: PanelState) => T | Promise<T>): Promise<T> {
    const operation = this.chain.then(async () => {
      const draft = clone(this.state);
      const result = await fn(draft);
      await this.pool.query("UPDATE panel_state SET state = $1::jsonb, updated_at = now() WHERE id = 1", [
        JSON.stringify(draft)
      ]);
      this.state = draft;
      return result;
    });
    this.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }
  async appendMetrics(batch: MetricBatch): Promise<void> {
    const rows: Array<{ scope: MetricScope; entityId: string; point: MetricPoint }> = [
      { scope: "node", entityId: batch.nodeId, point: batch.node },
      ...batch.instances.map((instance) => ({ scope: "instance" as const, entityId: instance.instanceId, point: instance.point }))
    ];
    if (!rows.length) return;
    const values: unknown[] = [];
    const rowsSql = rows.map((row, index) => {
      const offset = index * 11;
      values.push(row.scope, row.entityId, row.point.capturedAt, row.point.cpuPercent, row.point.memoryBytes, row.point.memoryLimitBytes, row.point.networkRxBytes, row.point.networkTxBytes, row.point.diskBytes ?? null, row.point.diskLimitBytes ?? null, row.point.pids ?? null);
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11})`;
    });
    await this.pool.query(`
      INSERT INTO metric_points (scope, entity_id, captured_at, cpu_percent, memory_bytes, memory_limit_bytes, network_rx_bytes, network_tx_bytes, disk_bytes, disk_limit_bytes, pids)
      VALUES ${rowsSql.join(", ")}
      ON CONFLICT (scope, entity_id, captured_at) DO UPDATE SET
        cpu_percent = EXCLUDED.cpu_percent,
        memory_bytes = EXCLUDED.memory_bytes,
        memory_limit_bytes = EXCLUDED.memory_limit_bytes,
        network_rx_bytes = EXCLUDED.network_rx_bytes,
        network_tx_bytes = EXCLUDED.network_tx_bytes,
        disk_bytes = EXCLUDED.disk_bytes,
        disk_limit_bytes = EXCLUDED.disk_limit_bytes,
        pids = EXCLUDED.pids
    `, values);
    if (Date.now() - this.lastMetricPruneAt >= 5 * 60 * 1000) {
      this.lastMetricPruneAt = Date.now();
      await this.pool.query("DELETE FROM metric_points WHERE captured_at < now() - INTERVAL '24 hours'");
    }
  }
  async getMetrics(scope: MetricScope, entityId: string, since: Date): Promise<MetricPoint[]> {
    const result = await this.pool.query<{
      captured_at: Date;
      cpu_percent: number;
      memory_bytes: string | number;
      memory_limit_bytes: string | number;
      network_rx_bytes: string | number;
      network_tx_bytes: string | number;
      disk_bytes: string | number | null;
      disk_limit_bytes: string | number | null;
      pids: number | null;
    }>(`
      SELECT captured_at, cpu_percent, memory_bytes, memory_limit_bytes, network_rx_bytes, network_tx_bytes, disk_bytes, disk_limit_bytes, pids
      FROM metric_points
      WHERE scope = $1 AND entity_id = $2 AND captured_at >= $3
      ORDER BY captured_at ASC
      LIMIT 2880
    `, [scope, entityId, since]);
    return result.rows.map((row) => ({
      capturedAt: new Date(row.captured_at).toISOString(),
      cpuPercent: Number(row.cpu_percent),
      memoryBytes: Number(row.memory_bytes),
      memoryLimitBytes: Number(row.memory_limit_bytes),
      networkRxBytes: Number(row.network_rx_bytes),
      networkTxBytes: Number(row.network_tx_bytes),
      diskBytes: row.disk_bytes === null ? undefined : Number(row.disk_bytes),
      diskLimitBytes: row.disk_limit_bytes === null ? undefined : Number(row.disk_limit_bytes),
      pids: row.pids ?? undefined
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const createStore = (databaseUrl?: string): StateStore =>
  databaseUrl ? new PostgresStateStore(databaseUrl) : new MemoryStore();
