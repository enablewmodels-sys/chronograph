# Chronograph Managed

[Open Chronograph](https://chronograph.13.57.235.204.nip.io). Managed adds accounts,
project provisioning, team roles, an encrypted secret vault, and project routing
around the Rust temporal graph engine. This deployment is a **launch preview**,
with bounded capacity and no availability SLA.

## Start a project

1. Choose **Start with GitHub**, or open a private email invitation from the
   platform operator. Email/password signup and automated password recovery await
   email delivery configuration; an email address alone does not create an account.
2. Set up an authenticator app. Save the one-time recovery codes privately, then
   verify a code. GitHub login also requires this second factor.
3. Open **Projects**, name your project, and create it. Each project has its own
   Rust process, journal, schema catalog, assets, credentials, and members.
4. In **Schema & migrations**, choose a connector preset or upload a JSON
   migration. Preview its changes, then apply the reviewed checksum and revision.
5. Open **Connections & API keys** to connect your backend or AI agent.

The current host admits at most three newly provisioned projects and two per
account. Provisioning stops when capacity is reached or less than 5 GiB of disk
space remains. Existing operator data remains in its original private project.
These are launch limits, not automatically scaling subscriptions.

## Accounts and project permissions

| Role | Graph access | Migrations and backups | Keys, secrets and members |
| --- | --- | --- | --- |
| Viewer | Read | Inspect schema | None |
| Editor | Read and write | Inspect schema | None |
| Admin | Read and write | Apply and operate | Manage, except owners/admins |
| Owner | Read and write | Apply and operate | Manage all project roles |

At least one active owner must remain. Suspending someone removes their access
only to that project. Application keys are independent credentials: revoke keys
that were shared with a departing collaborator. Permissions apply to the whole
project; there is no row-level or per-relation authorization.

Console sign-in uses HttpOnly cookies, not pasted API keys. Sessions expire after
12 hours or 30 minutes of inactivity. Key creation/revocation, secret changes,
team administration and provisioning require authenticator verification within
five minutes. Reverify in **Account security** when prompted. Changing a password
revokes all account sessions. Recovery codes are one-use; a lost authenticator
and lost recovery codes require operator-assisted identity verification.

Project invitations are private, single-use links bound to an existing account.
Ask collaborators to sign up with GitHub before inviting them. Until email delivery
is connected, only the platform operator can create a new email/password account. Share them
through your own trusted channel. Pending invitations can be reissued or revoked
under **Team**. Email accounts cannot automatically link to GitHub until their
local email has been independently verified. Project administrators cannot reset another person's global
account password. No automated email is sent until a delivery service is connected.

## API keys and endpoints

Create an expiring `read`, `ingest` (read/write), or `admin` key in **Connections &
API keys**. The full key is shown only once. Store it in your server's environment
or secret store. Keys expire after 1–365 days; revoke them immediately when no
longer needed. Admin keys can manage schema, keys and backups. Start agents with
read access and grant write access only when the workflow needs it.

Use the exact project API base URL shown in the console:

```sh
export CHRONOGRAPH_URL='https://YOUR_HOST/p/YOUR_PROJECT_ID'
# Supply CHRONOGRAPH_TOKEN through your secret manager or private environment.
curl "$CHRONOGRAPH_URL/v1/info" \
  -H "Authorization: Bearer $CHRONOGRAPH_TOKEN"
```

For the existing [SDKs](SDK.md), set the base URL to the HTTPS **origin**, without
`/p/...`. Keys issued through Managed route root `/v1/...` requests to their
project automatically. An explicit project URL never redirects a wrong-project
key to another project. A revoked or expired key fails authentication.

```ts
const response = await fetch(`${process.env.CHRONOGRAPH_URL}/v1/as_of`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.CHRONOGRAPH_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ t: "1000000", limit: 100 }),
});
if (!response.ok) throw new Error(`Chronograph returned ${response.status}`);
const graph = await response.json();
```

Run this in your backend. Browser applications call your own authenticated server;
API keys and provider secrets must never be embedded in public JavaScript. Direct
cross-origin browser API calls are intentionally rejected. For rotation: create a
replacement, update the application, verify requests, then revoke the old key.

REST operations and request schemas are in [API](API.md) and
[OpenAPI](https://github.com/enablewmodels-sys/chronograph/blob/main/sdk/schema/openapi.json). IDs and microsecond timestamps use
decimal strings. Public REST and MCP operation shapes match the Community engine;
Managed adds identity, project routing and project administration.

## MCP for AI agents

Copy the exact `/p/PROJECT_ID/mcp` endpoint from **Connections & API keys**. The
console includes configuration for Codex, Cursor and Claude Code. For Codex:

```toml
[mcp_servers.chronograph]
url = "https://YOUR_HOST/p/YOUR_PROJECT_ID/mcp"
bearer_token_env_var = "CHRONOGRAPH_TOKEN"
tool_timeout_sec = 60
```

Supply the key in the agent's environment. MCP uses Streamable HTTP and validates
scope on each tool invocation. A browser account cookie cannot authenticate an
MCP client. See [MCP](MCP.md) for initialization, other clients and the stdio bridge.
Read keys can query history; ingest keys can write; admin keys can apply migrations.

## Encrypted project secrets

In **Secrets**, save provider credentials such as `TYPESAFE_API_KEY`. Values are
AES-256-GCM encrypted at rest with project/name/version binding. The console lists
metadata only; rotation replaces the value and increments its version. Secret
values and API key values are excluded from audit records and are not placed in
graph properties.

Create a separate **secret-reader key** for the trusted backend that needs values.
These `cgs_` keys expire after 1–90 days and can read all vault entries in their own
project. They cannot authenticate graph or MCP requests. Graph API keys cannot
read the vault. A project supports up to 100 secrets and 20 active reader keys.

```sh
curl 'https://YOUR_HOST/p/YOUR_PROJECT_ID/secrets/TYPESAFE_API_KEY' \
  -H "Authorization: Bearer $CHRONOGRAPH_SECRET_READER_KEY"
```

The successful response contains `name`, `version`, and `value`; never log it.
Secret-reader keys are server credentials, not browser credentials. Model inference
still runs in your producer application. Saving a provider secret does not run a
model, attach BCI hardware, or execute a quantum circuit automatically.

## Database behavior

New Managed projects start with `default_durability: fsync`. Settings and relation
changes are persisted as migrations in that project's catalog. The migration
preview supplies a checksum and expected revision; concurrent conflicting changes
are rejected. Uploading a migration does not apply it until explicitly confirmed.

Graphs retain temporal edge versions, branches and connector-bound evidence.
The explorer offers network and tree layouts. The tree view draws a spanning
forest of the displayed nodes; it does not enforce single-parent or acyclic data.
Use [schema migrations](SCHEMA.md), [connectors](CONNECTOR_PLATFORM.md), and the
[Jev walkthrough](JEV.md) for actual data formats and supported boundaries.

## Hosting and recovery boundaries

The host uses HTTPS, loopback database sockets, unprivileged systemd services,
private data directories, and append-only project audit events with an HMAC chain.
New project processes share one service identity and machine; isolation is enforced
by the control plane and separate databases, not dedicated tenant virtual machines.
This is not a claim of independently audited enterprise isolation or certification.

Six-hour local backup timers cover the graph databases and Managed account/vault
state. Keep encrypted identity/configuration backups and their separate recovery key
alongside graph backups. Graph archives alone do not restore users, memberships,
API credentials or vault secrets. Capture and restore these as an operator workflow;
there is no cross-project transactional snapshot or point-in-time recovery service.

Local backups share the instance's failure domain. Automated off-host recovery,
replication, high availability, billing, custom domains, organization SSO, external
alert delivery and an uptime SLA are not provisioned. Monitor disk, memory, backup
freshness and key expiration before onboarding production workloads. Arrange an
independent security review and off-host recovery drill before sensitive BCI data.

The nip.io hostname follows the current public IP. An EC2 stop/start can change
that IP; use a stable address and owned domain for a permanent customer endpoint.
