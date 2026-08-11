# Durable task delivery and retries

## Context

MicoPanel targets no more than 20 nodes and 200 instances with one Fastify control plane,
PostgreSQL state storage, and outbound Agent WebSockets. Node connections may drop while an
operation is being delivered or while its result is returning. The panel must recover without
replaying a console command such as `op`, `stop`, or `say`.

## Options considered

- Add a message broker and worker fleet. This supplies queue primitives but adds a service to
  deploy and operate for the target scale.
- Keep failed tasks for a user to retry manually. This is simple but does not recover transient
  Docker or connection failures.
- Keep task state in the control plane and let the Agent persist successful results by task ID.
  The control plane can safely resend an unacknowledged task; the Agent returns the stored result
  instead of repeating completed work.

## Decision

Use the existing persistent control-plane state as the queue. A task receives at most three
automatic attempts with 15-second exponential backoff. Only idempotent lifecycle, backup, and
file metadata operations are retried automatically. Console commands, restores, and staged file
transfers stay failed for an authorized operator to retry explicitly.

Agents retain the latest 1,000 successful task results in a mode-0600 local journal. Receiving
the same task ID returns that result, which makes reconnect delivery at-least-once without
duplicating a completed operation. In-flight tasks that exceed two minutes enter the same retry
policy. A future deployment exceeding the stated scale can replace the state-store queue with a
dedicated broker while retaining the task ID and Agent journal contracts.
