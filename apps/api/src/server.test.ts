import assert from "node:assert/strict";
import test from "node:test";
import { buildServer } from "./server.js";
import { MemoryStore } from "./store.js";

const testConfig = {
  NODE_ENV: "test" as const,
  PORT: 0,
  HOST: "127.0.0.1",
  SESSION_SECRET: "test-session-secret-with-enough-length",
  APP_ENCRYPTION_KEY: "test-encryption-key-with-enough-length",
  BOOTSTRAP_USERNAME: "admin",
  BOOTSTRAP_PASSWORD: "unused-in-this-test",
  CORS_ORIGIN: "http://localhost:5173",
  ARTIFACTS_DIR: "./data/test-artifacts",
  ARTIFACT_MAX_BYTES: 1024 * 1024,
  ARTIFACT_TOKEN_TTL_MINUTES: 30
};

const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, payload: JSON.stringify(body) });

test("control plane bootstraps, queues workloads, and archives safely", async () => {
  const store = new MemoryStore();
  const app = await buildServer({ config: testConfig, store });
  try {
    const before = await app.inject({ method: "GET", url: "/api/auth/status" });
    assert.equal(before.statusCode, 200);
    assert.equal(before.json().setupRequired, true);

    const bootstrap = await app.inject({ method: "POST", url: "/api/auth/bootstrap", ...json({ username: "root", password: "correct-password-123" }) });
    assert.equal(bootstrap.statusCode, 200);
    const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0];
    assert.match(cookie, /^mico_session=/);

    const node = await app.inject({
      method: "POST",
      url: "/api/nodes",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "node-01", portRangeStart: 25565, portRangeEnd: 25566 })
    });
    assert.equal(node.statusCode, 201);
    const nodeBody = node.json() as { node: { id: string }; enrollmentToken: string };
    assert.equal(nodeBody.enrollmentToken.length > 30, true);

    const missingEula = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "eula-check", nodeId: nodeBody.node.id, kind: "paper", version: "1.21.4", memoryMb: 1024, cpuCores: 1, diskMb: 2048, pids: 128 })
    });
    assert.equal(missingEula.statusCode, 422);

    const instance = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "survival", nodeId: nodeBody.node.id, kind: "paper", version: "1.21.4", memoryMb: 2048, cpuCores: 1, diskMb: 4096, pids: 256, eulaAccepted: true })
    });
    assert.equal(instance.statusCode, 202);
    const instanceBody = instance.json() as { instance: { id: string; ports: Array<{ host: number }> }; task: { status: string; type: string } };
    assert.equal(instanceBody.task.status, "queued");
    assert.equal(instanceBody.task.type, "instance.create");
    assert.equal(instanceBody.instance.ports[0].host, 25565);

    const syncFiles = await app.inject({ method: "POST", url: `/api/instances/${instanceBody.instance.id}/files/sync`, headers: { cookie } });
    assert.equal(syncFiles.statusCode, 202);
    assert.equal(syncFiles.json().task.type, "file.list");

    const missingArtifact = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "custom-missing", nodeId: nodeBody.node.id, kind: "custom", version: "21", memoryMb: 1024, cpuCores: 1, diskMb: 2048, pids: 128, eulaAccepted: true })
    });
    assert.equal(missingArtifact.statusCode, 422);
    const artifactId = "11111111-1111-4111-8111-111111111111";
    await store.transaction((state) => {
      state.artifacts.push({ id: artifactId, fileName: "server.jar", storageName: `${artifactId}.jar`, mimeType: "application/java-archive", sizeBytes: 12, checksum: "test", createdBy: "test", createdAt: new Date().toISOString() });
    });
    const custom = await app.inject({
      method: "POST",
      url: "/api/instances",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "custom-valid", nodeId: nodeBody.node.id, kind: "custom", version: "21", memoryMb: 1024, cpuCores: 1, diskMb: 2048, pids: 128, artifactId, eulaAccepted: true })
    });
    assert.equal(custom.statusCode, 202);
    const artifactTask = (await store.read()).tasks.find((task) => task.instanceId === custom.json().instance.id)!;
    assert.equal(typeof (artifactTask.payload.artifact as { token?: unknown }).token, "string");

    const backup = await app.inject({ method: "POST", url: `/api/instances/${instanceBody.instance.id}/backups`, headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify({ destination: "local" }) });
    assert.equal(backup.statusCode, 202);
    const backupBody = backup.json() as { backup: { id: string } };
    await store.transaction((state) => {
      const record = state.backups.find((candidate) => candidate.id === backupBody.backup.id)!;
      record.status = "available";
    });
    const restore = await app.inject({ method: "POST", url: `/api/instances/${instanceBody.instance.id}/backups/${backupBody.backup.id}/restore`, headers: { cookie } });
    assert.equal(restore.statusCode, 202);
    assert.equal(restore.json().task.type, "instance.restore");

    const archive = await app.inject({ method: "DELETE", url: `/api/instances/${instanceBody.instance.id}`, headers: { cookie } });
    assert.equal(archive.statusCode, 202);
    assert.match(String(archive.json().recoverUntil), /^20\d\d-/);

    const dashboard = await app.inject({ method: "GET", url: "/api/dashboard", headers: { cookie } });
    assert.equal(dashboard.statusCode, 200);
    assert.equal(dashboard.json().instances[0].status, "archived");
  } finally {
    await app.close();
  }
});
