# Phase 3 — Community service preview

Status: PASS for the local checkpoint. Continue with Community connectors under
the accepted batch authorization. Managed/control-plane/billing work stays gated.

## Built

- Server: scoped Argon2id tokens, external locked auth store, offline bootstrap,
  versioned API, per-request durability, revision/query-bound cursors, bounded
  work admission, safe errors and retired cookie/password routes.
- `backup.rs`: synchronized tar bundles with manifest, journal, disposable index
  snapshot and owned sidecars; streamed download and staging/replay restore.
- Native `chronograph-mcp`: official SDK stdio-to-HTTP bridge with TLS/redirect
  policy and no automatic uncertain-write retry. Canonical tools plus documented
  compatibility tools enforce scopes on every request.
- Console: memory-only token connection, scope-aware navigation, explicit fsync
  writes, authenticated downloads, opaque cursor handling and synthetic preview.
- Reproducible protocol, latency and twice-per-viewport browser suites; updated
  API/quickstart/security/MCP/ops/format/testing/deployment docs.

## Dependencies

- `tar`: portable streamed archives with explicit validated extraction.
- `reqwest` with Rustls: native bridge TLS, timeout and redirect configuration.
- Existing `rmcp` gains client, stdio and HTTP client features to use the official
  protocol implementation on both sides of the bridge.
- Development `tower`: exercise actual Axum middleware/routes through oneshot.
- No new frontend runtime dependency. Lockfiles retain resolved versions.

## Actual verification output

Workspace build, tests, Clippy with denied warnings and fmt all exited zero;
exact commands and timings are in results.json and their individual logs.

```text
running 8 tests
test auth::tests::rate_limits_invalid_credentials_before_expensive_hashing ... ok
test backup::tests::invalid_and_incomplete_archives_leave_no_destination ... ok
test backup::tests::backup_restore_sidecars_and_source_preservation ... ok
test auth::tests::malformed_credentials_and_commit_failure_fail_closed ... ok
test auth::tests::salted_tokens_cache_revocation_expiry_and_lock ... ok
test service_tests::worker_queue_is_bounded_and_cancellation_releases_waiters ... ok
test service_tests::invalid_requests_cannot_mutate_and_cookie_routes_are_retired ... ok
test service_tests::scopes_exact_ids_durability_pagination_and_revocation ... ok

test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.91s
```

`protocol.log` records all eight network/SDK checks passing, including independent
restored-service history comparison and process kill/restart. `browser.log` records
8 passed: both workflows on desktop and mobile, repeated twice, with no relevant
page or console errors. `ui-build.log` records a successful TypeScript/Vite build.
The independent JS SDK exercised both HTTP MCP and the native Rust stdio bridge.
Actual client-app interactive sessions were not exercised.

Local Apple M5 / Rust 1.93 / 100k-version parsed-response measurements (full data
in latency.json and latency-samples.csv): HTTP 1000-row page p50/p95/p99
3.778/5.309/6.427 ms; MCP 4.701/5.363/6.452 ms; single fsync write
3.853/5.213/6.041 ms. Eight-client HTTP p99 13.900 ms and MCP p99 17.874 ms.
These are loopback measurements, not production guarantees or engine-only scans.

## Corrections found by verification

Axum route overlap was removed. Direct SPA routes now return 200. Vite emits
small fonts as files to honor the unchanged restrictive CSP. The network body-limit
check uses Expect/Continue to observe an early 413; streaming overflow is also
covered without a Content-Length in the Rust route test. Ordinary oversized fetch
uploads may observe TCP reset when the server rejects the body early.

## Deviations and known gaps

The supplied PRD is absent; the accepted plan/master brief remains the contract.
UI source stays in the existing `ui/` directory to preserve project layout. The
full dark-console/light-landing redesign is still due; generated concepts live in
docs/design/v0.3.0. Current screenshots verify behavior, not final design fidelity.
Synthetic preview intentionally has no persistence, Arrow export or uniform engine
sampler; it is labeled and rejects unsupported operations visibly.

Backups serialize a logical index cache; restore deliberately replays the journal
and checks cache metadata rather than claiming accelerated startup. The configured
rate-limit middleware is a Tower/Axum layer with token-specific counters and a
separate bounded Argon2 admission path. No password/session/CSRF path remains.

Docker/Neo4j and deployed Caddy/TLS remain PENDING after daemon timeout. Container
recipes still need the release-packaging update for the new auth/bootstrap layout.
Native binaries are locally built; multi-platform bundles and CI execution are
later gates. Hardware connectors, durable branches, final benchmarks, mdbook and
full release hardening are not claimed complete. The phase-3 preview warning is
retained in help/health as requested. GitHub/AWS publication is deferred.

Next: implement F20 BCI first, then robotics, world-model and exploratory quantum
adapters, each over the public engine API and Arrow with real round-trip evidence.
