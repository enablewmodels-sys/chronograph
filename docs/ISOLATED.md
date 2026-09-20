# Self-hosted and isolated Chronograph

Run the Community engine on infrastructure you control. In this guide, **isolated**
means a separately operated database with its own process, storage, credentials
and network boundary. Use a dedicated VM or host when you need an operating-system
boundary between customers. A second directory or graph branch is not that boundary.
For accounts, team invitations and hosted provisioning, use [Managed](HOSTED.md).

Both deployments use the same temporal graph, migration, REST and MCP contracts.
Community does not include the private Managed account service or secret vault.
The current release is an alpha; review [production operations](PRODUCTION.md)
and [known limits](LIMITATIONS.md) before choosing a workload.

## Choose the deployment

| Concern | Managed | Isolated Community |
| --- | --- | --- |
| Console sign-in | GitHub or invited email account, plus MFA | Scoped API key held in browser memory |
| Applications and agents | Project API key | Workspace API key |
| REST base | `https://HOST/p/PROJECT_ID` | Your server's HTTPS origin |
| SDK base | Managed HTTPS origin; key selects project | Your server's HTTPS origin |
| MCP endpoint | `https://HOST/p/PROJECT_ID/mcp` | `https://HOST/mcp` |
| Team roles and provider vault | Managed console | Supply your own identity gateway and secret manager |
| Backups, capacity and upgrades | Hosting operator | You |
| Data boundary | Separate processes and stores on a shared host | Determined by your host, filesystem and network deployment |

## Run your own database

Requires Rust 1.93+, Node 22 and npm. Clone the
[Community repository](https://github.com/enablewmodels-sys/chronograph), then run
these commands from its root. Choose new directories for a new deployment:

```sh
npm --prefix ui ci
npm --prefix ui run build
cargo build --locked --release -p chronograph-server --bins
umask 077
mkdir -p config
export CHRONOGRAPH_DATA="$PWD/community-data"
export CHRONOGRAPH_AUTH="$PWD/config/auth.json"
export CHRONOGRAPH_REQUIRE_FSYNC=true
./target/release/chronograph-server admin create-token operator admin 90 config/admin.token
./target/release/chronograph-server serve
```

Open [the local console](http://127.0.0.1:8080/login). Read the private
`config/admin.token` file locally and connect. Bootstrap writes a mode-0600 token
file exclusively; it refuses to overwrite an existing file. The credential store
contains an Argon2id hash. Never commit either file or put credentials under the
graph directory, public UI or documentation root.

The server binds loopback by default. It does not require GitHub, an email provider
or the Managed service. A browser reload clears the Community console credential.
Use **Connections & API keys** to issue a separate read or ingest key for each
application; keep the operator key private. Keys have expiration and revocation.

`CHRONOGRAPH_REQUIRE_FSYNC=true` forces durable acknowledgements on service writes
and rejects requests or settings migrations that explicitly select buffered
durability. It does not change the embedded Rust API's defaults. Acknowledgements
still depend on the host and storage honoring synchronization.

## Define relations and import data

1. Open **Schema & migrations** with an admin key.
2. Select a connector/model preset, or upload a migration JSON file.
3. Inspect the named relations, property layouts and settings in its preview.
4. Apply using the preview's checksum and revision. A concurrent catalog change
   requires a fresh preview; retrying blindly is not a migration strategy.
5. Ingest a small fixture and query its history before connecting the full stream.

Presets describe supported data contracts. They do not install a model, connect
hardware or run quantum jobs. Read [schema migrations](SCHEMA.md),
[connector support](CONNECTOR_PLATFORM.md), [Jev](JEV.md) and the shared
[temporal tutorial](TUTORIAL.md). Trees in the explorer are a layout of graph
data; the database does not enforce single-parent or acyclic relationships.

## Connect software and agents

Use your server origin in the [language SDKs](SDK.md) and a private scoped key.
REST routes start with `/v1`; timestamps and identifiers are decimal strings.
The same operations are available through [MCP](MCP.md). Copy client configuration
from the console, replace the endpoint with your host, and provide the credential
through the agent's private environment. Read-only agents should have read keys.

Backend services hold credentials and authorize their own users. Do not embed
database keys in browser JavaScript, mobile bundles or public examples. Keep model
provider credentials in an external secret manager; the Community database is not
a credential vault. Direct cross-origin browser access is rejected.

## Separate databases and remote access

Give each database a distinct `CHRONOGRAPH_DATA`, `CHRONOGRAPH_AUTH`, listening
port and configured origin. Never start multiple processes against one journal or
share a credential store between running instances. Each store has an exclusive
process lock. Isolate service accounts, volumes and networks for untrusted tenants.

For remote deployment, follow [the native and Compose recipes](DEPLOYMENT.md).
Terminate HTTPS at a trusted proxy, keep the engine socket private, run as an
unprivileged user and use persistent private data/config volumes. Set resource
limits based on measured full-history memory use. Do not expose port 8080 publicly.
An isolated network without internet can run the prebuilt binary and UI; build
dependencies and external model calls still need a separate supply process.

## Back up, restore and upgrade

Graph archives contain the journal, schema and sidecar assets. They exclude
credentials. Encrypt and retain a separate copy of the external auth store when
credentials must survive. Put backups outside the host's failure domain, with
restricted access and a documented recovery key owner.

Use [Operations](OPERATIONS.md) to restore into a new empty directory, check known
historical queries and reconnect clients. Restoring an old credential store also
restores old revocation state; rotate affected keys. Test recovery on an independent
host before relying on it. Preserve the old binary and lockfiles during upgrades.

Use [production checks and monitoring](PRODUCTION.md) for durable-write policy,
writer health, authentication, backup freshness and capacity. This release has
one writer per database, retains history in memory and does not provide replication,
automatic failover, retention/compaction or cross-database transactions.
