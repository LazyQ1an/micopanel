import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "./runtime.js";

test("node resource snapshots report usable host metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "micopanel-agent-"));
  const runtime = new DockerRuntime("/var/run/docker.sock", root, () => undefined);
  try {
    const usage = await runtime.usage();
    assert.equal(Number.isFinite(usage.cpuPercent), true);
    assert.equal(usage.cpuPercent >= 0 && usage.cpuPercent <= 100, true);
    assert.equal(usage.memoryLimitBytes > 0, true);
    assert.equal(usage.diskLimitBytes > 0, true);
    assert.equal(usage.diskBytes >= 0, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agent rejects paths that escape an instance directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "micopanel-agent-"));
  const runtime = new DockerRuntime("/var/run/docker.sock", root, () => undefined);
  const safeFilePath = (runtime as unknown as { safeFilePath(instanceId: string, path: string): Promise<string> }).safeFilePath.bind(runtime);
  try {
    const safePath = await safeFilePath("instance-01", "/server.properties");
    assert.equal(safePath.endsWith("server.properties"), true);
    await assert.rejects(() => safeFilePath("instance-01", "/../agent-credentials.json"), /Unsafe file path/);
    await assert.rejects(() => safeFilePath("instance-01", "/plugins\\escape.jar"), /Unsafe file path/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
