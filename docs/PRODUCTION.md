# Production operations and readiness

Chronograph currently ships as **0.4.0-alpha.3**. The Managed site is a launch
preview, and Community is a single-owner database. Passing the checks below is
evidence for a specific deployment, not an availability SLA, independent security
audit or guarantee that an arbitrary workload fits in memory.

Start with [Managed](HOSTED.md) or [isolated Community](ISOLATED.md). Both use the
same engine health, durability and backup interfaces. Their operating duties differ:

| Responsibility | Managed project user | Isolated Community operator |
| --- | --- | --- |
| Access | Account MFA, project members, expiring application keys | Bootstrap, rotate and revoke workspace keys |
| Durability | Host enforces fsync; inspect Operations | Set `CHRONOGRAPH_REQUIRE_FSYNC=true` |
| Monitoring | Inspect project Operations; report service failures | Collect metrics, host capacity, backup age and external probes |
| Disaster recovery | Hosting operator captures graph and account/vault state | Back up graph, external auth store and deployment configuration |
| Capacity and upgrades | Work within published host limits | Measure memory/disk, test restores and retain rollback artifacts |

## Durable writes and readiness

Set `CHRONOGRAPH_REQUIRE_FSYNC=true` on every production engine process. The Compose
recipe enables it. Managed engines use this floor. Omitted durability becomes
`fsync`; explicitly buffered writes and migrations that set buffered defaults are
rejected. `/v1/info` reports `require_fsync`, effective `default_durability` and
`configured_default_durability`. The operator floor can override an older catalog's
buffered default. `/v1/stats` and the Operations page report the effective policy.

`/healthz` is process liveness. `/readyz` checks that the graph can be read without
waiting and that the journal writer has not entered a failed state. It can return
503 during a write or backup; retry a few times before alerting. Do not use this
readiness response as a process restart trigger. `/v1/stats.writer_healthy` records
known writer failures, not a forecast of disk capacity or a full integrity scan.

On an append or sync failure, stop accepting writes. Investigate storage, preserve
the files, then reopen with the service's checked recovery path. An unacknowledged
write may have committed: inspect its result or connector receipt before retrying.
Never delete a journal lock to start another writer.

## Authenticated metrics

`GET /v1/metrics` returns Prometheus text format. Use a dedicated read key, stored
in a private file. Anonymous requests return 401. For Managed, use the explicit
project path `/p/PROJECT_ID/v1/metrics` and a key belonging to that project.

```yaml
scrape_configs:
  - job_name: chronograph
    scheme: https
    metrics_path: /p/PROJECT_ID/v1/metrics # Self-hosted: /v1/metrics
    authorization:
      type: Bearer
      credentials_file: /run/secrets/chronograph-read.token
    static_configs:
      - targets: ['YOUR_HOST']
```

Use the [Prometheus configuration reference](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
for TLS and file permissions. Mount the key read-only and rotate it before expiry.
Do not attach user IDs, API keys, secret names or arbitrary paths as metric labels.

| Metric | Meaning |
| --- | --- |
| `chronograph_uptime_seconds` | Engine process age |
| `chronograph_http_requests_total` | Requests observed at the engine boundary |
| `chronograph_http_server_errors_total` | Engine HTTP responses with 5xx status |
| `chronograph_graph_nodes`, `chronograph_edge_versions` | Current stored graph counts |
| `chronograph_journal_bytes` | Journal file size |
| `chronograph_recovered_tail_bytes` | Bytes recovered from a torn tail on open |
| `chronograph_writer_healthy` | 1 when the journal permits writes, otherwise 0 |
| `chronograph_workers_available`, `chronograph_admission_available` | Unoccupied execution/admission permits |
| `chronograph_fsync_required` | 1 when the operator durability floor is enabled |

Counters reset at engine restart. These metrics exclude requests rejected by an
upstream Managed gateway or TLS proxy. Collect those services' logs and status
separately. Scrape failures, a disabled writer, sustained 5xx and exhausted worker
capacity need investigation. Monitor host free disk, RAM and backup age independently;
graph metrics do not report the entire host's resource use.

## Run deployment checks

The repository includes a read-only probe. Save a scoped read key in a private
mode-0600 file and run from the source checkout:

```sh
python3 scripts/production-check.py \
  --url https://YOUR_HOST/p/YOUR_PROJECT_ID \
  --token-file /private/chronograph-read.token
```

For Community use the origin without `/p/...`. HTTP is accepted only on loopback.
The probe refuses redirects so credentials cannot follow them to another host.
It checks liveness, readiness, anonymous rejection, authenticated API/stats,
enforced durability and authenticated metrics without writing graph data. It emits
JSON and a nonzero exit code when a required check fails. Run it after deployment
and from an independent monitor; protect its credential like any other API key.

On the storage host, add `--data-dir /private/data --min-free-gib 5` to check free
disk. Use `--backup-file /private/completed-backup.tar --max-backup-age-hours 8`
to inspect an actual completed archive. Repeat `--backup-file` for graph and
encrypted identity archives. This checks regular-file presence, nonzero size and
age; it does not decrypt the archive, prove restorability or establish off-host
storage. Do not point it at a timer file or a timestamp written before completion.

## Backup and recovery gates

1. Capture a synchronized graph archive and preserve its checksums.
2. For Community, capture external credentials and deployment configuration in a
   maintenance window. For Managed, also capture identity SQLite, project membership,
   vault encryption keys, per-project auth stores and routing configuration.
3. Encrypt recovery material and put it on independent storage. Separate the
   decryption key from the archive; define who can recover it.
4. Restore into a new location using the matching release. Compare graph revision,
   schema, connector sidecars and known historical queries. For Managed, also verify
   membership, API routing, vault decryption and revocation behavior.
5. Record the recovery duration and latest recoverable timestamp. Set business
   recovery objectives from those measurements and repeat after format changes.

A six-hour schedule alone does not guarantee a six-hour recovery point: failed
captures and missing off-host copies extend the gap. A graph archive does not
restore Managed accounts or secrets. Local backups can be lost with the host.
See [backup and restore](OPERATIONS.md) for the supported archive workflow.

## Upgrade and rollback gates

Retain the current binary, lockfiles, deployment configuration and independently
verified recovery bundle. Build and test the candidate against a restored copy.
Drain active requests before stopping engines; allow backup requests and fsync to
finish. Managed shutdown drains HTTP before stopping project engines and closing
identity storage. A failing project restore is recorded without preventing healthy
projects from starting. Investigate failed projects before restoring their traffic.

Restart with private persistent directories intact, then run the deployment probe,
known queries, a scoped write/read test in a disposable project and a fresh backup.
Keep compatible rollback artifacts until acceptance. Never open a newer journal
format with an older binary. See [upgrade requirements](UPGRADE_0_4.md).

## Current hosted boundaries

The live host has TLS, MFA for accounts, scoped keys, separate project stores,
fsync enforcement, health/metrics endpoints and six-hour local backup timers.
An encrypted recovery copy has been captured outside the instance manually.
Automated off-host backup, external alert delivery, replication and automatic
failover are **not configured**. Email signup/recovery awaits an email provider;
GitHub and operator-issued email invitations are the available account paths.

New tenant engines share one Unix identity and machine. Dedicated tenant VMs,
organization SSO, billing, a stable owned customer domain and an availability SLA
are not delivered by this release. Full history remains in memory and the journal
has no retention or compaction. Validate realistic data size and request concurrency
before onboarding a workload; do not infer capacity from a small synthetic benchmark.
