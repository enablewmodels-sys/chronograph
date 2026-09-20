# Hosted alpha verification — 2026-09-20

Target: dedicated AWS t4g.medium (ARM64, two vCPUs, 4 GiB nominal RAM), us-west-1.
Native release build, Caddy public TLS, one unprivileged systemd workspace.
The database is bound to loopback; firewall inbound TCP 22, 80 and 443 only.

- Rust server library tests on the deployment architecture: **21 passed**.
- Python SDK unit tests: **8 passed**; TypeScript SDK tests: **6 passed**.
- Official TypeSafe Python 0.7.0 and JS 0.6.0 mock-transport compatibility passed.
  No live Jev inference was performed; no provider API key was supplied.
- Both example programs ingested a labeled synthetic Jev record over public TLS,
  uploaded JSON request/response assets and read the durable record back.
- Authenticated ingestion, latest exact retry, invalid-decision rejection and
  non-advancing checkpoint checks passed. Unauthenticated access, foreign Origin,
  read-token writes and a revoked token were rejected.
- The official MCP client connected over TLS, discovered Jev and enforced read
  scope. Interactive configuration inside Codex/Cursor/Claude was not repeated.
- A backup was downloaded off-host and restored into a separate workspace on the
  same instance. Record contents, assets and checkpoint matched. The test service
  was then stopped. This is not a cross-region failover test.
- The six-hour systemd timer is installed, and its backup service completed a
  manual invocation successfully. Three local archives are retained. Automated
  off-host backup and external alerting are not provisioned.
- Notebook code cells and both examples in a clean extracted bundle ran offline.

`latency.json` records 30 sequential samples per operation from the operator's
laptop through public HTTPS using a warm persistent connection and a tiny graph:

| Operation | p50 | p95 | p99 (sample maximum) |
| --- | --- | --- | --- |
| As-of query | 172.620 ms | 224.421 ms | 228.367 ms |
| Jev record + fsync, existing assets | 179.541 ms | 228.661 ms | 242.003 ms |

These include network latency, use synthetic records and do not measure Jev
inference. They are neither load-test capacity nor a latency SLA. No production
data, raw credentials, browser traces or private deployment files are included.

Public-browser QA passed two full rounds each at 1440×1000 and 390×844: banner,
docs/download, token connection, Jev migration selectors, reload logout, no
credential in browser storage and no console/runtime errors. Browser plugin was
unavailable; headed Playwright provided screenshots and interaction checks.

Final checks also passed restart persistence and four live backup rotations at
capacity. The private rotation helper passed failed-capture rollback and
interrupted-run recovery fixtures. A final rotated archive was downloaded
off-host and restored again. The temporary restore listener was stopped.

The complete connector platform test also passed against an isolated workspace
on the ARM64 host: all 36 presets, asset validation, exact record export,
idempotent retries, invalid Jev probability rejection without checkpoint advance,
MCP discovery, SIGKILL recovery and independent backup restoration. The missing
tensor test selects JEPA explicitly rather than depending on catalog order.
