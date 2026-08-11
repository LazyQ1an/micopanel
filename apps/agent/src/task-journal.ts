import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CompletedTaskResult {
  message: string;
  data?: Record<string, unknown>;
}

interface JournalEntry {
  completedAt: string;
  result: CompletedTaskResult;
}

interface JournalState {
  completed: Record<string, JournalEntry>;
}

export class TaskJournal {
  private state: JournalState = { completed: {} };

  constructor(private readonly filePath: string, private readonly limit = 1_000) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<JournalState>;
      if (parsed.completed && typeof parsed.completed === "object" && !Array.isArray(parsed.completed)) this.state.completed = parsed.completed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.state = { completed: {} };
    }
  }

  get(taskId: string): CompletedTaskResult | undefined {
    const entry = this.state.completed[taskId];
    return entry ? structuredClone(entry.result) : undefined;
  }

  async record(taskId: string, result: CompletedTaskResult): Promise<void> {
    this.state.completed[taskId] = { completedAt: new Date().toISOString(), result: structuredClone(result) };
    const entries = Object.entries(this.state.completed).sort((left, right) => right[1].completedAt.localeCompare(left[1].completedAt));
    this.state.completed = Object.fromEntries(entries.slice(0, this.limit));
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
