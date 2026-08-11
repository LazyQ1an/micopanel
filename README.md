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

## Custom server packages

When creating a **custom package** instance, an administrator uploads one `.jar` or `.zip`
server package in the create dialog. The control plane stores it in the persistent
`api-artifacts` volume and gives the assigned Agent a short-lived, task-scoped download token.
The Agent downloads it directly after authenticating to the control plane; it never receives
browser credentials or access to the panel's storage volume.

For a JAR upload, MicoPanel uses that file as the custom entry JAR by default. For a ZIP upload,
set the entry JAR name (for example `server.jar`) if the archive does not use that default. ZIP
entries are path-checked before extraction and are limited to 2 GB uncompressed. Configure
`ARTIFACT_MAX_BYTES` and `ARTIFACT_TOKEN_TTL_MINUTES` in the control-plane `.env` to adjust the
upload limit and the time available for a queued Agent to download a package.

## Instance files

The instance file workspace supports directory browsing, text editing, uploads, and downloads
without exposing a node filesystem or Docker socket to the browser. Text files are read through
the Agent and capped at 1 MB for editing. Uploads are staged in the control-plane
`api-file-transfers` volume, then the target Agent fetches and SHA-256-verifies the stream before
an atomic write into the instance data directory. Downloads follow the reverse path: the Agent
streams a regular file to the control plane and the browser receives it only after the transfer is
complete.

Set `FILE_TRANSFER_MAX_BYTES` and `FILE_TRANSFER_TOKEN_TTL_MINUTES` in the control-plane `.env`
to control the maximum upload/download size and the retention period for a pending or ready
transfer. Each transfer has a task-scoped token; expired, failed, and completed-upload staging
files are removed automatically. Instance collaborators still require the `instance.files`
permission for every file route.

## Collaborators

Every instance has an owner. The owner and panel administrators can add, edit, or remove
collaborators directly in the instance workspace, selecting only the permissions required for
viewing, console commands, power operations, files, configuration, backups, or schedules.
Administrators can also create a local collaborator account from the same panel. A collaborator
with configuration access cannot delegate access to other users: membership changes remain
restricted to the instance owner or an administrator and are recorded in the audit log.

## Instance configuration

The instance workspace provides a controlled configuration operation for server version, game
port, CPU, memory, PID, data-capacity settings, and additional environment variables. Applying a
configuration requires an explicit confirmation because the Agent stops and recreates the managed
container while preserving its `/data` directory. Host ports are reserved from the node pool in
the same control-plane transaction, so a requested conflicting or out-of-range port is rejected
rather than silently remapped.

Only additional environment variables are editable. Template-defined server type, Mojang EULA,
runtime version and memory values, and a trusted custom JAR entry are panel-managed and cannot be
overridden through the browser or API configuration request.

## Scheduled tasks

The instance workspace can create, edit, pause, resume, and delete cron schedules for backups,
restarts, and console commands. Managing a schedule requires `instance.schedules`; its action
also requires the corresponding operation permission: `instance.backups` for backups,
`instance.power` for restarts, and `instance.console` for commands. This prevents a collaborator
from using a schedule to gain an ability that was not granted directly.

Scheduled backups can target the node's local backup store or the Agent's configured S3/MinIO
destination. The control plane records the backup and submits the actual work to the Agent when
the schedule becomes due. Disabling a schedule clears its next run time; enabling it calculates a
fresh run time from the stored cron expression.

## Security baseline

- Browser sessions use signed, HttpOnly cookies.
- Passwords are hashed with Argon2.
- Node enrollment tokens are single-use and stored hashed.
- Agents maintain outbound WebSocket connections and never publish the Docker socket.
- Custom package downloads are authorized with short-lived tokens and are verified by SHA-256
  when stored by the control plane.
- Instance membership changes are owner/admin-only and are recorded in the audit log.
- Every destructive or control operation is written to the audit log.
