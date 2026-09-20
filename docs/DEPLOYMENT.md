# Deploy Managed or isolated Community

The public repository builds **self-hosted Community**. Follow the [isolated
quickstart](ISOLATED.md) and [production gates](PRODUCTION.md) when operating your
own database. The private Managed control plane adds accounts, projects, roles
and secrets; its service is documented in [Managed](HOSTED.md). Deploying the
Community container does not install that private account service.

The Managed preview runs natively on ARM64 EC2 behind Caddy HTTPS. Docker build
and an isolated non-root container bootstrap/restart smoke test passed in GitHub
CI on September 20, 2026. That check does not validate your public TLS deployment,
disaster recovery or capacity. The static [Community website](WEBSITE.md) serves
documentation and a synthetic demo; Vercel is not hosting a persistent Rust database.

## Native configuration

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOGRAPH_DATA` | `./community-data` | Private graph/sidecar/backup directory |
| `CHRONOGRAPH_AUTH` | `./config/auth.json` | Private v2 credential store, outside data |
| `CHRONOGRAPH_BIND` | `127.0.0.1:8080` | Listen socket |
| `CHRONOGRAPH_ORIGIN` | `http://127.0.0.1:8080` | Exact public origin; remote origins require HTTPS |
| `CHRONOGRAPH_UI` | `ui/dist` | Built UI files |
| `CHRONOGRAPH_REQUIRE_FSYNC` | `false` | Set `true` to enforce fsync and reject buffered writes/settings |
| `CHRONOGRAPH_DOCS` | `docs` | Public documentation only; never a secret directory |

Create the initial admin token before serving. Stop the service for offline auth
commands, journal checks, migration or destination restore. `check` replays and
may repair a torn tail; it is not a forensic read-only operation. Use a copy for
investigation. The Community engine has no account sessions; Managed owns account authentication
separately. The old `CHRONOGRAPH_PASSWORD_FILE` setting is removed.

## Single-host container boundary

The supplied Caddyfile terminates HTTPS, preserves Host, caps request bodies and
does not retry writes. Verify this container topology independently. Publish only ports
80/443 from the proxy; keep the plaintext database socket private. Run as an
unprivileged UID with a read-only root filesystem and writable data/config volumes. Enable `CHRONOGRAPH_REQUIRE_FSYNC=true`; the Compose recipe
already sets it.
Config must have a separate private mount. Retain certificate state separately.
Pin reviewed image digests at release and preserve the built binaries/lockfiles.

One process owns each journal. Do not horizontally scale owners of one volume or
place journals on an unverified shared filesystem. Size memory for complete history
and indexes plus materialized queries. Size disk for the journal, sidecars, up to
three archives and temporary capture/restore copies. Local benchmarks do not
establish an AWS instance size or production latency objective.

## Release smoke test

After a deployment is actually provisioned: check HTTPS/Host/Origin boundaries,
verify unauthenticated `/v1/info` returns 401, connect the console, create a read
machine token, query through an actual MCP client, revoke it and verify rejection.
Download a backup and restore it into an independent workspace; compare known
historical queries and sidecars. Restart and verify fsync-acknowledged data.
Measure representative traffic through the deployed TLS proxy. Verify resource
limits, disk exhaustion handling and log redaction. These are deployment gates,
not completed claims; see [testing evidence](TESTING.md).

## Container bootstrap recipe

Requires Docker with Compose, a hostname pointing to your host, and inbound 80/443.
Copy `deploy/.env.example` to `deploy/.env` and replace its hostname/email. Values
are deployment configuration, not application credentials. From the source root:

```sh
docker compose --project-directory deploy --env-file deploy/.env -f deploy/compose.yaml build
# No server is listening yet. Bootstrap uses the separate graph-config volume.
docker compose --project-directory deploy --env-file deploy/.env -f deploy/compose.yaml run --no-deps --name chronograph-bootstrap chronograph admin create-token operator admin 90 /config/admin.token
umask 077
mkdir -p deploy/secrets
docker cp chronograph-bootstrap:/config/admin.token deploy/secrets/admin.token
chmod 600 deploy/secrets/admin.token
docker rm chronograph-bootstrap
docker compose --project-directory deploy --env-file deploy/.env -f deploy/compose.yaml up -d
```

Read the private token file locally and connect at your configured HTTPS origin.
The token itself is never put in an image, environment file, command argument or
container logs. Bootstrap refuses to replace an existing token output file; use
a new filename during recovery. Stop the service before offline administration.
The default 2 GiB limit is a starter configuration, not sizing for a 10M-version
history. Increase it after measuring your workload's peak resident memory.

Both graph-data and graph-config are persistent named volumes initialized for
UID/GID 10001. Host bind mounts need equivalent ownership and mode 0700 directories;
the service will not run as root to repair arbitrary mounts. Never use Compose
`down -v` unless you explicitly intend to delete persistent data and credentials.
Ordinary `stop`, image upgrades and `down` without `-v` retain volumes.

For an isolated container check after `docker build -t chronograph:ci .`, run
`python3 scripts/container-smoke.py --image chronograph:ci`. It creates unique
temporary volumes, tests offline bootstrap, non-root operation, auth, docs and a
durable branch across restart, then removes only those temporary resources. This
script does not prove public TLS, disaster recovery or production sizing.
