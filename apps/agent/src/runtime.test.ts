import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, instanceUsageFromStats } from "./runtime.js";

test("container resource snapshots normalize Docker stats", () => {
  const usage = instanceUsageFromStats({
    cpu_stats: { cpu_usage: { total_usage: 700 }, system_cpu_usage: 1_200, online_cpus: 4 },
    precpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1_000 },
    memory_stats: { usage: 700, limit: 2_000, stats: { cache: 100 } },
    networks: { bridge: { rx_bytes: 11, tx_bytes: 13 }, private: { rx_bytes: 17, tx_bytes: 19 } },
    pids_stats: { current: 9 }
  });
  assert.deepEqual(usage, {
    cpuPercent: 100,
    memoryBytes: 600,
    memoryLimitBytes: 2_000,
    networkRxBytes: 28,
    networkTxBytes: 32,
    pids: 9
  });
});

test("container resource snapshots handle invalid CPU deltas", () => {
  assert.equal(instanceUsageFromStats({ cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 20 }, precpu_stats: { cpu_usage: { total_usage: 20 }, system_cpu_usage: 10 } }).cpuPercent, 0);
  assert.equal(instanceUsageFromStats({ cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 10 }, precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 10 } }).cpuPercent, 0);
});

test("node resource snapshots report usable host metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "micopanel-agent-"));
  const runtime = new DockerRuntime("/var/run/docker.sock", root, () => undefined);
  try {
    const usage = await runtime.usage();
    assert.equal(usage.cpuCores > 0, true);
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
