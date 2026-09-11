# Benchmark results

The final Community candidate was measured on an Apple M5 (10 cores, 16 GiB),
macOS 26.5 arm64, Rust 1.93.0 release build, ten Rayon workers and warm OS caches.
**The Mac was on AC power with Low Power Mode enabled.** The host was not isolated;
no power setting was changed. These are engine timings, not remote service latency.

## Actual final results

100,000 nodes, 10 million relationship versions over one hour, ten relationships
per node and about 10% explicit invalidations. Seed: `4848215499434033153`. Every
final interval is compared with an independent generated reference.

| Workload | Final measurement | Target / result |
|---|---:|---|
| Ordered batch insertion + final sync | 1,104,833 versions/s | ≥2M/s — MISSED |
| Ordered single insertion + final sync | 547,251 versions/s | ≥500k/s — PASS |
| Shuffled batches + final sync | 941,933 versions/s | Reported separately |
| Shuffled singles + final sync | 559,132 versions/s | Reported separately |
| Full as-of p50 / p99 | 19.053 / 19.805 ms | p50 <10 ms — MISSED |
| Full 36-second between p50 / p99 | 22.812 / 23.782 ms | No stated target |
| LatestFirst returned sampling | 27.69M edges/s | ≥5M/s — PASS |
| Uniform returned sampling | 24.74M edges/s | ≥5M/s — PASS |
| Arrow materialization, 949,342 rows | 31.187 ms | No stated target |

Ingestion is buffered insertion followed by one sync, not fsync per edge.
Explicit invalidations and their sync happen afterward, outside insertion timing.
As-of consumes every result for 200 timestamps after ten warmups; between consumes
all results for 200 windows. Sampling counts actual output rows across 200 batches
of 10,000 nodes, k=10. An unused O(1) view construction is never timed as traversal.

Whole-run peak resident memory was 3.49–4.04 GB across the four generator/ingest/
validate/reopen runs. The ordered batch journal was 698,050,224 bytes and reopened
in 10.645 seconds. Memory is not bounded by journal size, and the measurements are
not a production instance-sizing recommendation.

Separate Criterion estimates: full as-of 11.749 ms (CI 11.543–12.105), between
21.791 ms (21.037–22.599). Fixed-timestamp sampling and 100k ingestion use different
workloads and cannot replace the full-run figures. `bench/RESULTS.md` in the source
bundle retains all figures, commands, confidence intervals and caveats.

## Earlier checkpoint and next comparison

Phase 2 measured 2.304M ordered batches/s and as-of p50 8.440 ms on the same
hardware, before later features. Its power state was not recorded. The current
slower results remain the final candidate numbers. A controlled run with a matched
baseline is needed to attribute the difference to code or environment; no claim
that Low Power Mode alone explains it is made. Performance targets remain open.

Neo4j is PENDING: a bounded Docker daemon query timed out after eight seconds.
The source bundle's `bench/neo4j/` has the exact comparison recipe. No Neo4j, cloud,
TLS or hardware acquisition performance is invented.

## Working examples

The final synthetic BCI example ingested 1M versions over 128 channels in 0.824 s
including sync (1,213,640/s) and found its expected high-synchrony window. The
small world-model temporal replay, Arrow and reopen example also passed.

The phase-5 durable-fork example created 100 forks from a three-record prefix,
restored all 3158 branch records, selected reward 0.85, merged one future and
discarded 99. Creation took 0.166 ms, toy parallel simulation 0.312 ms, serialized
persistence/close/sync 824.965 ms and selected merge/sync 4.052 ms. These are one-run
toy measurements, not a GPU simulator or large-base fork benchmark.

## Reproduce

From a fresh source checkout, build `cargo build --locked --release --workspace
--bins --examples`, then run `python3 scripts/release/bench-final.py`. It refuses
to replace its named dataset directory; choose an explicitly new path for another
full run. Raw CSVs/logs, RSS and environment are under
`bench/reports/v0.3.0/phase-8-release/`. [Service latency](TESTING.md) uses a separate
100k-version authenticated loopback workload.
