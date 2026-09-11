# Deployment preparation

Community 0.4.0-alpha.2 is currently verified locally as a single-workspace service.
**Container and deployed TLS verification are PENDING.** Docker's daemon did not
respond to bounded checks on this machine, including after opening Docker Desktop.
Community source and versioned alpha downloads are published on GitHub. Managed
hosting is not available. The static public site serves docs and a synthetic demo;
it does not host a database or accept API tokens. See [Vercel website deployment](WEBSITE.md).

Use the [native quickstart](QUICKSTART.md) for the tested installation. Docker/Compose
now uses a separate private config volume and offline scoped-token bootstrap.
The recipe below is prepared; its execution is pending a responsive Docker daemon.

## Native configuration

| Variable | Default | Meaning |
|---|---|---|
| `CHRONOGRAPH_DATA` | `./community-data` | Private graph/sidecar/backup directory |
| `CHRONOGRAPH_AUTH` | `./config/auth.json` | Private v2 credential store, outside data |
| `CHRONOGRAPH_BIND` | `127.0.0.1:8080` | Listen socket |
| `CHRONOGRAPH_ORIGIN` | `http://127.0.0.1:8080` | Exact public origin; remote origins require HTTPS |
| `CHRONOGRAPH_UI` | `ui/dist` | Built UI files |
| `CHRONOGRAPH_DOCS` | `docs` | Public documentation only; never a secret directory |

Create the initial admin token before serving. Stop the service for offline auth
commands, journal checks, migration or destination restore. `check` replays and
may repair a torn tail; it is not a forensic read-only operation. Use a copy for
investigation. Removed settings: `CHRONOGRAPH_PASSWORD_FILE` and browser sessions.

## Intended single-host container boundary

The supplied Caddyfile terminates HTTPS, preserves Host, caps request bodies and
does not retry writes. Deployed verification remains due. Publish only ports
80/443 from the proxy; keep the plaintext database socket private. Run as an
unprivileged UID with a read-only root filesystem and writable data/config volumes.
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

## Container bootstrap recipe (execution pending)

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
