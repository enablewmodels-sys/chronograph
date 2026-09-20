# Operations

For hosted projects, start with [Managed](HOSTED.md). For an independently
operated database, start with [isolated Community](ISOLATED.md). The graph archive
commands below apply to both engines; Managed account/vault recovery is a separate
operator responsibility. See [production monitoring and recovery gates](PRODUCTION.md).

One process owns `community-data/graph.cgraph`; `config/auth.json` stays outside
that directory. Both use OS advisory locks. Do not remove or bypass locks while
a process is active. The embedded graph and its indexes retain complete history
in memory; monitor RAM and disk growth.

## Observe and synchronize

`/healthz` checks process liveness, `/readyz` attempts a read lock and checks writer health, and `/v1/stats`
returns counts, revision, journal size and recovered tail bytes. Readiness can
return 503 during writes. It is not a disk-capacity or integrity check.

API/MCP writes use the catalog default, initially buffered in a local Community
workspace. Managed and the production Compose recipe enforce fsync. Set
`CHRONOGRAPH_REQUIRE_FSYNC=true` on independently operated production engines.
The floor rejects explicit buffered writes and buffered settings migrations.
Without the floor, send `durability: "fsync"` for a durable acknowledgement.
The console sends fsync for writes. `/v1/metrics` exposes authenticated operational
metrics; `/v1/stats` reports the effective policy and known writer health.
SIGINT/SIGTERM drain requests and synchronize. Allow sufficient shutdown time for
large snapshots; a forced kill can lose buffered acknowledgements. An uncertain
write may survive even without acknowledgement: inspect history before retrying.

## Schema operations

Use [Schema & migrations](SCHEMA.md) to change relation definitions and service settings. Apply requires an admin token and a valid preview; history and typed property layouts persist in `schema.json`. Do not edit that file manually. It is included in new backups and validated on restore. Existing backups without a catalog continue to restore with default settings.

## Backup and restore

Admin `POST /v1/backup` takes the graph write lock, synchronizes the journal,
copies it, serializes `index.snapshot` and copies regular files beneath `sidecars/`.
It creates a tar archive with a versioned manifest and SHA-256 checksum/size for
each file. Only the synchronized, renamed archive is listed. Authentication files
and unrelated workspace files are excluded. Bounds are 3 completed local archives,
10,000 files and 100 GiB per capture. Capture temporarily needs additional disk
space and pauses readers/writers for its duration.

Download `/v1/backups/{id}` or use Operations. Keep a copy on separate storage;
a local sibling file is not disaster recovery. Delete older local archives after
retaining the required copies. With the service stopped, remove abandoned
`.pending-*` directories/files only after confirming no backup is active.

```sh
CHRONOGRAPH_DATA=./restored-data ./target/release/chronograph-server restore /absolute/path/backup.tar
CHRONOGRAPH_DATA=./restored-data ./target/release/chronograph-server check
CHRONOGRAPH_DATA=./restored-data CHRONOGRAPH_AUTH=./config/auth.json ./target/release/chronograph-server serve
```

The destination must be absent or empty. Restore streams regular files into a
private staging directory, validates every declared file and replays the journal.
The logical index snapshot is a checked disposable cache; journal replay remains
authoritative. Corruption, a torn journal, invalid paths or mismatched revision
fail before exposing a usable destination. The source archive is never repaired
or overwritten. Failure cleans the new staging directory. Existing destination
data is never replaced. Test counters and known historical queries before writers
reconnect. Independent HTTP restore tests are in `scripts/protocol-test.mjs`.

Keep encrypted operator backups of `config/auth.json` separately if credentials
must survive. Restoring an older auth store also restores its older token/revocation
state: rotate credentials after suspected compromise. Credential and graph stores
are not one atomic multi-file transaction. A maintenance window is required for
a mutually consistent operator backup.

## Lost or expired administrator token

Stop the service and preserve the external auth file. Create a new admin token
with the offline CLI, using a new output file:

```sh
./target/release/chronograph-server admin create-token recovery-admin admin 30 config/recovery.token
```

The CLI requires access to the private config and its exclusive lock. It does not
expose an unauthenticated network reset route. Existing tokens stay unchanged;
revoke compromised entries after connecting with the recovery token. If all 100
slots are occupied, retain the old auth store and initialize a separate config
path, then rotate all clients. Do not manually weaken stored hash parameters.

## Upgrade from journal version 1

0.4 writes journal format **3**, with explicit checked record encoding. Format-2
workspaces need the [explicit upgrade](UPGRADE_0_4.md). The engine refuses
version 1 at open and does not modify the source. Stop the old service, retain its
binary and credentials, and migrate to a **new** journal filename:

```sh
mkdir -p migrated-data
./target/release/chronograph-server migrate-v1 ./data/graph.cgraph ./migrated-data/graph.cgraph
CHRONOGRAPH_DATA=./migrated-data ./target/release/chronograph-server check
```

Migration validates checksums/semantics and creates a new destination exclusively.
Existing, locked or torn sources/destinations fail safely. Old password sessions
and SHA-based machine credentials cannot be upgraded: create scoped v2 tokens in
an external config and reconnect clients. Old journal-only `.cgraph` backups can
be migrated through this command; the new `restore` command expects a tar bundle.

Before future upgrades, preserve an archive, binary, Cargo.lock and external config.
Test a restore with the new reader on separate storage. Roll back with the matching
old binary and compatible backup, not by feeding a newer format into an older reader.

## Performance and failure handling

Watch memory, free space, 5xx, 429 and queue latency. Full time/history scans are
O(E); outgoing neighbors use ordered indexes. Batches amortize durable commits.
Arrow export materializes a batch and is capped at 1M stored versions in HTTP.
Larger exports use the embedded API. Rate limits return 429; saturation returns
503. Respect Retry-After, reduce concurrency, and inspect write outcomes before
retrying mutations. Backups and long scans hold the graph lock while executing.

Container bootstrap/restart is covered by CI; your TLS topology and recovery
procedure still require deployment-specific verification. See [testing](TESTING.md)
and the [release contract](REQUIREMENTS.md) for actual gate status.
