# Resource metrics storage

## Decision

Keep five-second host heartbeats in the current node record for live status, but store sampled
node and instance metrics in a dedicated `metric_points` table. Agents collect container stats at
30-second intervals from Docker labels; the control plane rejects samples for instances that do
not belong to the authenticated node. Samples are retained for 24 hours and queried by scope and
entity ID.

## Rationale

Embedding history in the existing JSON state would rewrite the whole state document on every
heartbeat and make PostgreSQL writes grow with history size. A separate table preserves the
modular-monolith deployment while keeping time-series reads indexed and bounded. Prometheus is
not required for the initial 20-node/200-instance target and can consume this boundary later.
