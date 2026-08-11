import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskJournal } from "./task-journal.js";

test("agent task journal replays successful task results after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "micopanel-journal-"));
  const filePath = join(root, "task-journal.json");
  try {
    const journal = new TaskJournal(filePath);
    await journal.init();
    await journal.record("task-01", { message: "container started", data: { port: 25565 } });
    const reloaded = new TaskJournal(filePath);
    await reloaded.init();
    assert.deepEqual(reloaded.get("task-01"), { message: "container started", data: { port: 25565 } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
