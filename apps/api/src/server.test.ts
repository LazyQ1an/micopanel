import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
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
  ARTIFACT_TOKEN_TTL_MINUTES: 30,
  FILE_TRANSFERS_DIR: "./data/test-file-transfers",
  FILE_TRANSFER_MAX_BYTES: 1024 * 1024,
  FILE_TRANSFER_TOKEN_TTL_MINUTES: 30
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
    const capturedAt = new Date().toISOString();
    await store.appendMetrics({
      nodeId: nodeBody.node.id,
      capturedAt,
      node: { capturedAt, cpuPercent: 21, memoryBytes: 2_000, memoryLimitBytes: 4_000, networkRxBytes: 100, networkTxBytes: 80 },
      instances: [{ instanceId: instanceBody.instance.id, point: { capturedAt, cpuPercent: 8, memoryBytes: 700, memoryLimitBytes: 2_048, networkRxBytes: 50, networkTxBytes: 40, pids: 23 } }]
    });
    const instanceMetrics = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/metrics?minutes=15`, headers: { cookie } });
    assert.equal(instanceMetrics.statusCode, 200);
    assert.equal(instanceMetrics.json().metrics[0].pids, 23);
    const nodeMetrics = await app.inject({ method: "GET", url: `/api/nodes/${nodeBody.node.id}/metrics?minutes=15`, headers: { cookie } });
    assert.equal(nodeMetrics.statusCode, 200);
    assert.equal(nodeMetrics.json().metrics[0].cpuPercent, 21);

    const configWithoutConfirmation = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/config`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ version: "1.21.4", port: 25566, environment: { MOTD: "MicoPanel" }, limits: { memoryMb: 2048, cpuCores: 1, diskMb: 4096, pids: 256 } })
    });
    assert.equal(configWithoutConfirmation.statusCode, 422);
    const configWithManagedVariable = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/config`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ version: "1.21.4", port: 25566, environment: { EULA: "FALSE" }, limits: { memoryMb: 2048, cpuCores: 1, diskMb: 4096, pids: 256 }, confirmRecreate: true })
    });
    assert.equal(configWithManagedVariable.statusCode, 422);
    const configUpdate = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/config`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ version: "1.21.5", port: 25566, environment: { MOTD: "MicoPanel" }, limits: { memoryMb: 3072, cpuCores: 1.5, diskMb: 8192, pids: 320 }, confirmRecreate: true })
    });
    assert.equal(configUpdate.statusCode, 202);
    const configBody = configUpdate.json() as { instance: { version: string; ports: Array<{ host: number }>; limits: { memoryMb: number; pids: number }; environment: Record<string, string> }; configuration: { environment: Record<string, string>; managedEnvironment: Record<string, string> } };
    assert.equal(configBody.instance.version, "1.21.5");
    assert.equal(configBody.instance.ports[0].host, 25566);
    assert.equal(configBody.instance.limits.memoryMb, 3072);
    assert.equal(configBody.instance.limits.pids, 320);
    assert.equal(configBody.configuration.environment.MOTD, "MicoPanel");
    assert.equal(configBody.configuration.managedEnvironment.EULA, "TRUE");

    const syncFiles = await app.inject({ method: "POST", url: `/api/instances/${instanceBody.instance.id}/files/sync`, headers: { cookie } });
    assert.equal(syncFiles.statusCode, 202);
    assert.equal(syncFiles.json().task.type, "file.list");

    const boundary = "micopanel-test-boundary";
    const upload = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/files/upload?path=%2Fops.txt`,
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ops.txt"\r\nContent-Type: text/plain\r\n\r\nhello from panel\r\n--${boundary}--\r\n`
    });
    assert.equal(upload.statusCode, 202);
    const uploadBody = upload.json() as { transfer: { id: string; checksum: string }; task: { id: string; type: string } };
    assert.equal(uploadBody.task.type, "file.upload");
    const uploadTask = (await store.read()).tasks.find((task) => task.id === uploadBody.task.id)!;
    const uploadToken = (uploadTask.payload.transfer as { token: string }).token;
    const agentFetch = await app.inject({ method: "GET", url: `/api/agent/file-transfers/${uploadBody.transfer.id}?token=${uploadToken}` });
    assert.equal(agentFetch.statusCode, 200);
    assert.equal(agentFetch.body, "hello from panel");
    const rejectedAgentFetch = await app.inject({ method: "GET", url: `/api/agent/file-transfers/${uploadBody.transfer.id}?token=${"x".repeat(32)}` });
    assert.equal(rejectedAgentFetch.statusCode, 403);

    const download = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/files/download`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ path: "/latest.log" })
    });
    assert.equal(download.statusCode, 202);
    const downloadBody = download.json() as { transfer: { id: string; status: string }; task: { id: string; type: string } };
    assert.equal(downloadBody.task.type, "file.download");
    const downloadTask = (await store.read()).tasks.find((task) => task.id === downloadBody.task.id)!;
    const downloadToken = (downloadTask.payload.transfer as { token: string }).token;
    const agentUpload = await app.inject({
      method: "POST",
      url: `/api/agent/file-transfers/${downloadBody.transfer.id}?token=${downloadToken}`,
      headers: { "content-type": "application/octet-stream", "content-length": "16" },
      payload: "node log content"
    });
    assert.equal(agentUpload.statusCode, 201);
    const transferStatus = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/file-transfers/${downloadBody.transfer.id}`, headers: { cookie } });
    assert.equal(transferStatus.json().transfer.status, "available");
    const browserDownload = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/file-transfers/${downloadBody.transfer.id}/download`, headers: { cookie } });
    assert.equal(browserDownload.statusCode, 200);
    assert.equal(browserDownload.body, "node log content");

    const collaboratorAccount = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ username: "builder", password: "correct-builder-123" })
    });
    assert.equal(collaboratorAccount.statusCode, 201);
    const collaborator = collaboratorAccount.json().user as { id: string; username: string };
    const membersBefore = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/members`, headers: { cookie } });
    assert.equal(membersBefore.statusCode, 200);
    assert.equal(membersBefore.json().canManage, true);
    assert.equal(membersBefore.json().users.some((user: { id: string }) => user.id === collaborator.id), true);
    const memberWrite = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/members/${collaborator.id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ permissions: ["instance.view", "instance.config", "instance.schedules"] })
    });
    assert.equal(memberWrite.statusCode, 200);
    const collaboratorLogin = await app.inject({ method: "POST", url: "/api/auth/login", ...json({ username: "builder", password: "correct-builder-123" }) });
    assert.equal(collaboratorLogin.statusCode, 200);
    const collaboratorCookie = String(collaboratorLogin.headers["set-cookie"]).split(";")[0];
    const collaboratorView = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}`, headers: { cookie: collaboratorCookie } });
    assert.equal(collaboratorView.statusCode, 200);
    const collaboratorFileAccess = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/files`, headers: { cookie: collaboratorCookie } });
    assert.equal(collaboratorFileAccess.statusCode, 403);
    const collaboratorConfigUpdate = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/config`,
      headers: { cookie: collaboratorCookie, "content-type": "application/json" },
      payload: JSON.stringify({ version: "1.21.5", port: 25566, environment: { MOTD: "Builder managed" }, limits: { memoryMb: 3072, cpuCores: 1.5, diskMb: 8192, pids: 320 }, confirmRecreate: true })
    });
    assert.equal(collaboratorConfigUpdate.statusCode, 202);
    const collaboratorSchedules = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}/schedules`, headers: { cookie: collaboratorCookie } });
    assert.equal(collaboratorSchedules.statusCode, 200);
    const collaboratorCommandSchedule = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/schedules`,
      headers: { cookie: collaboratorCookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "越权命令", cron: "0 4 * * *", action: "command", payload: { command: "say should-not-run" } })
    });
    assert.equal(collaboratorCommandSchedule.statusCode, 403);
    const collaboratorBackupSchedule = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/schedules`,
      headers: { cookie: collaboratorCookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "越权备份", cron: "0 4 * * *", action: "backup", payload: { destination: "s3" } })
    });
    assert.equal(collaboratorBackupSchedule.statusCode, 403);
    const collaboratorMemberWrite = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/members/${collaborator.id}`,
      headers: { cookie: collaboratorCookie, "content-type": "application/json" },
      payload: JSON.stringify({ permissions: ["instance.view"] })
    });
    assert.equal(collaboratorMemberWrite.statusCode, 403);
    const memberRemove = await app.inject({ method: "DELETE", url: `/api/instances/${instanceBody.instance.id}/members/${collaborator.id}`, headers: { cookie } });
    assert.equal(memberRemove.statusCode, 204);
    const collaboratorAfterRemove = await app.inject({ method: "GET", url: `/api/instances/${instanceBody.instance.id}`, headers: { cookie: collaboratorCookie } });
    assert.equal(collaboratorAfterRemove.statusCode, 403);

    const failedCommandTaskId = "22222222-2222-4222-8222-222222222222";
    await store.transaction((state) => {
      state.tasks.unshift({
        id: failedCommandTaskId,
        type: "instance.command",
        nodeId: nodeBody.node.id,
        instanceId: instanceBody.instance.id,
        payload: { command: "say manual retry" },
        status: "failed",
        attempt: 3,
        message: "控制台不可用",
        createdBy: "system",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });
    const removedCollaboratorRetry = await app.inject({ method: "POST", url: `/api/tasks/${failedCommandTaskId}/retry`, headers: { cookie: collaboratorCookie } });
    assert.equal(removedCollaboratorRetry.statusCode, 403);
    const manualRetry = await app.inject({ method: "POST", url: `/api/tasks/${failedCommandTaskId}/retry`, headers: { cookie } });
    assert.equal(manualRetry.statusCode, 202);
    assert.equal(manualRetry.json().task.type, "instance.command");
    assert.notEqual(manualRetry.json().task.id, failedCommandTaskId);

    const createdSchedule = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/schedules`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "每日公告", cron: "0 4 * * *", action: "command", payload: { command: "say scheduled" } })
    });
    assert.equal(createdSchedule.statusCode, 201);
    const scheduleId = createdSchedule.json().schedule.id as string;
    const invalidSchedule = await app.inject({
      method: "POST",
      url: `/api/instances/${instanceBody.instance.id}/schedules`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "空命令", cron: "0 4 * * *", action: "command", payload: { command: "" } })
    });
    assert.equal(invalidSchedule.statusCode, 422);
    const updatedSchedule = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/schedules/${scheduleId}`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ name: "每日 S3 备份", cron: "0 5 * * *", action: "backup", payload: { destination: "s3" }, enabled: false })
    });
    assert.equal(updatedSchedule.statusCode, 200);
    assert.equal(updatedSchedule.json().schedule.enabled, false);
    assert.equal(updatedSchedule.json().schedule.payload.destination, "s3");
    assert.equal(updatedSchedule.json().schedule.nextRunAt, undefined);
    const deletedSchedule = await app.inject({ method: "DELETE", url: `/api/instances/${instanceBody.instance.id}/schedules/${scheduleId}`, headers: { cookie } });
    assert.equal(deletedSchedule.statusCode, 204);

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
    const portConflict = await app.inject({
      method: "PUT",
      url: `/api/instances/${instanceBody.instance.id}/config`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ version: "1.21.5", port: 25565, environment: { MOTD: "Collision" }, limits: { memoryMb: 3072, cpuCores: 1.5, diskMb: 8192, pids: 320 }, confirmRecreate: true })
    });
    assert.equal(portConflict.statusCode, 409);
    assert.equal((await store.read()).audits.some((audit) => audit.action === "instance.config.updated"), true);

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
    await rm(testConfig.ARTIFACTS_DIR, { recursive: true, force: true });
    await rm(testConfig.FILE_TRANSFERS_DIR, { recursive: true, force: true });
  }
});
