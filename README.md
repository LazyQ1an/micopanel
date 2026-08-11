# MicoPanel

MicoPanel is a Chinese-first, self-hosted control plane for Minecraft Java and Bedrock servers.
It keeps the panel separate from Docker nodes: agents connect outward to the panel, so nodes may
live behind NAT without opening their Docker API to the internet.

## Local development

```powershell
pnpm install
pnpm dev
```

Open `http://localhost:5173`. Without `DATABASE_URL`, the API uses an in-memory development
store. Production uses PostgreSQL through `docker compose up -d --build` after copying
`.env.example` to `.env` and setting every secret.

## Production model

1. Deploy the control plane with `docker compose up -d --build`.
2. In the panel, create a node and copy its one-time enrollment token.
3. On the Linux Docker host, copy `deploy/agent-compose.yml`, create `.env`, then run
   `docker compose up -d`.

The first panel account is created from `BOOTSTRAP_USERNAME` and `BOOTSTRAP_PASSWORD`. Change
the bootstrap password before the first start; it is only honored when no users exist.

For remote backups, set `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, and
`S3_SECRET_ACCESS_KEY` together in the Agent `.env`. Any S3-compatible provider, including
MinIO, is supported; credentials stay on the node and are never sent to the browser.

## Security baseline

- Browser sessions use signed, HttpOnly cookies.
- Passwords are hashed with Argon2.
- Node enrollment tokens are single-use and stored hashed.
- Agents maintain outbound WebSocket connections and never publish the Docker socket.
- Every destructive or control operation is written to the audit log.
