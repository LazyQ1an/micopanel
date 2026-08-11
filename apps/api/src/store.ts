import { Pool } from "pg";
import { createEmptyState, type PanelState } from "./types.js";

export interface StateStore {
  init(): Promise<void>;
  read(): Promise<PanelState>;
  transaction<T>(fn: (state: PanelState) => T | Promise<T>): Promise<T>;
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
  async close(): Promise<void> {}
}

export class PostgresStateStore implements StateStore {
  private readonly pool: Pool;
  private state = createEmptyState();
  private chain = Promise.resolve();

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

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export const createStore = (databaseUrl?: string): StateStore =>
  databaseUrl ? new PostgresStateStore(databaseUrl) : new MemoryStore();
