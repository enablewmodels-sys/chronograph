# Upgrade to the 0.4 alpha

0.4 introduces journal format 3. The server refuses to open a format-2 journal directly. Existing data is never automatically rewritten in place. Keep your working 0.3 binary and source data until verification is complete. Migration version 1 remains supported independently of journal versions.

## Preferred: restore a 0.3 backup into a new workspace

Create and download a synchronized backup using your running 0.3 server. Then use the new binary with a destination that does not exist:

```sh
CHRONOGRAPH_DATA=upgraded-data ./target/release/chronograph-server restore /absolute/path/to/backup.tar
CHRONOGRAPH_DATA=upgraded-data ./target/release/chronograph-server check
```

The backup archive is read-only. Restore verifies its manifest, copies files into a temporary staging directory, upgrades a format-2 journal there, validates catalog history and journal/index counts, synchronizes, and finally exposes the new destination. A failed restore does not replace a working workspace.

Start a separate loopback instance using the upgraded destination and a separate auth-store copy, or stop the old service before reusing its auth store. Each auth store and each graph journal permits one owning process. Verify graph counts, active branches, schema and sample connector exports before changing your normal startup configuration. Keep credentials outside the data directory and preserve mode 0600 on credential files.

## Offline journal-only upgrade

```sh
./target/release/chronograph-server migrate-v2 old-data/graph.cgraph new-data/graph.cgraph
```

Create `new-data` first. The destination journal must not exist. This command takes an exclusive source lock and fails if another process is using it. It does not copy schema or sidecars: copy those from the same stopped workspace, retaining all file names and directory structure. Prefer backup restore when a catalog or sidecars are present. Version-1 journals use `migrate-v1`, which now produces format 3.

Never copy a live journal and sidecars independently and assume the snapshot is consistent. Do not point a 0.3 binary at format-3 data. Rollback means using the retained 0.3 workspace; there is no format-3-to-2 downgrade and new 0.4 writes are not present in that retained copy.

The workspace in this checkout has not been upgraded in place. Test harnesses create their own temporary data/auth directories.
