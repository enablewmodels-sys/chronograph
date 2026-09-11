# Phase 2 — benchmarks and examples

Status: PASS for the engine workload and required Rust gate. Neo4j remains PENDING:
Docker did not return from its daemon query, including after opening Docker Desktop.

Changed: the measure runner accepts a report directory and measures consumed
between traversals; Criterion includes between; single inserts bypass Rayon batch
preparation while retaining the same atomic journal frame. README and bench/RESULTS.md
contain actual checkpoint results. Existing reports and graph files are preserved.
No new dependencies.

Evidence: results.json records successful workspace build, tests, Clippy and fmt.
The four measure logs cover 10M versions each; criterion.log and both example logs
retain complete command output. environment.json describes the host. Ordered batch
ingestion including final sync reached 2,303,587 versions/s; full as-of p50 was
8.440 ms. These are engine measurements on a developer Mac, not service or cloud
latency guarantees. Peak memory was not collected. Final release reruns remain due.

Continue into the Community service phase under the accepted batch authorization.
Managed implementation and publishing remain gated as recorded in REQUIREMENTS.md.
