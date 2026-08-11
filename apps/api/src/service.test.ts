import assert from "node:assert/strict";
import test from "node:test";
import { isAutomaticRetryableTask, MAX_TASK_ATTEMPTS, nextTaskRetryAt, TASK_RETRY_BASE_DELAY_MS } from "./service.js";

test("task retry policy retries only operations that are safe to replay", () => {
  assert.equal(MAX_TASK_ATTEMPTS, 3);
  assert.equal(isAutomaticRetryableTask({ type: "instance.restart" }), true);
  assert.equal(isAutomaticRetryableTask({ type: "instance.backup" }), true);
  assert.equal(isAutomaticRetryableTask({ type: "file.write" }), true);
  assert.equal(isAutomaticRetryableTask({ type: "instance.command" }), false);
  assert.equal(isAutomaticRetryableTask({ type: "instance.restore" }), false);
  assert.equal(isAutomaticRetryableTask({ type: "file.download" }), false);
  const before = Date.now();
  const retryAt = new Date(nextTaskRetryAt(2)).getTime();
  assert.equal(retryAt >= before + TASK_RETRY_BASE_DELAY_MS * 2, true);
  assert.equal(retryAt <= Date.now() + TASK_RETRY_BASE_DELAY_MS * 2 + 1_000, true);
});
