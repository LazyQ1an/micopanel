import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "./store.js";

test("memory metrics store keeps bounded node and instance samples", async () => {
  const store = new MemoryStore();
  const capturedAt = new Date().toISOString();
  await store.appendMetrics({
    nodeId: "node-01",
    capturedAt,
    node: { capturedAt, cpuPercent: 12, memoryBytes: 512, memoryLimitBytes: 1024, networkRxBytes: 10, networkTxBytes: 20 },
    instances: [{ instanceId: "instance-01", point: { capturedAt, cpuPercent: 4, memoryBytes: 128, memoryLimitBytes: 512, networkRxBytes: 3, networkTxBytes: 4, pids: 18 } }]
  });
  const nodePoints = await store.getMetrics("node", "node-01", new Date(Date.now() - 60_000));
  const instancePoints = await store.getMetrics("instance", "instance-01", new Date(Date.now() - 60_000));
  assert.equal(nodePoints.length, 1);
  assert.equal(nodePoints[0].cpuPercent, 12);
  assert.equal(instancePoints[0].pids, 18);
});
