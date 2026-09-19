# Hosted Managed alpha

This deployment offers one operator-managed workspace using the Community
engine: hosted HTTPS API, browser console, migrations, connector presets, binary
assets and MCP. Access is invitation-only through scoped workspace tokens.
It is an alpha, with no availability or durability SLA.

Current pilot: [Chronograph Managed alpha](https://chronograph.13.57.235.204.nip.io).

## Connect

Open your deployment's `/login` page and paste the token issued by the operator.
The console keeps it in memory and clears it on reload. Read tokens can inspect
all data in the workspace; ingest tokens can write; admin tokens manage
migrations, credentials and backups. These scopes are not per-user or row-level
permissions. Only share a workspace with collaborators who may access its data.

SDKs use the same HTTPS origin and bearer token. The MCP endpoint is `/mcp`; see
[agent integrations](MCP.md) for client configuration. Keep agent tokens in the
client's local secret store or environment and issue the narrowest scope needed.
Never embed workspace or provider keys in a public website or downloadable example.

Try the [Jev example](JEV.md), or choose a connector under **Schema & migrations
→ Migrations → Start from a connector**, preview the migration and apply it with an admin token.

## Operations supplied with this pilot

- A dedicated database process and private data/config directories.
- TLS termination with automatic certificate renewal, exact Host/Origin checks
  and a database socket bound only to loopback.
- An unprivileged systemd service with restart policy, filesystem restrictions
  and a memory limit; persistent data stays outside versioned release folders.
- A six-hour timer for consistent local backups, retaining the engine's last
  three archives. Use Operations to download an archive for off-host storage.
- Operator access over SSH for releases, recovery, token bootstrap and inspection.

A local archive on the same instance is not disaster recovery. Scheduled remote
backups, externally monitored alerts, high availability, capacity scaling and
an independent recovery service have not been provisioned. The operator must
retain off-host backups and monitor disk space, memory and token expiry.

## Boundaries

Self-service signup, billing, organizations, team roles, SSO, project provisioning,
replication, cross-region recovery and customer-specific quotas are not present.
Do not invite unrelated customers into this shared workspace. Separate tenant
processes/volumes and an account control plane must precede a multi-tenant launch.
The service reports `edition: community` because that is its database engine;
the hosted console describes how that engine is operated.

The nip.io hostname follows the instance's public IP. If the IP changes after
an EC2 stop/start, the old hostname will no longer reach this instance. Use an
Elastic IP and your own domain before publishing a permanent customer endpoint.
No Elastic IP or paid cloud backup service is created by this recipe.
