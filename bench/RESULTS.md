# Chronograph 0.3.0 benchmark results

Final Community candidate run on 9 September 2026. Apple M5, 4 performance + 6
efficiency cores (10 logical), 16 GiB RAM, macOS 26.5 arm64, Rust 1.93.0, release
build with thin LTO and 10 Rayon workers. **AC Low Power Mode was enabled.** No
power setting was changed. Warm OS caches; developer host without CPU/process
isolation. The earlier phase-2 power state was not recorded. Its faster results
are retained as a separate checkpoint and cannot establish a controlled regression
comparison. These are engine timings, not HTTP or cloud latency guarantees.

## Full 10-million-version workload

100,000 nodes, ten relationships per node, ten starts per relationship over one
hour, about 10% explicit invalidations, seed `4848215499434033153`. Every resulting
interval is compared against an independently generated expected end. Generation
and validation are excluded from ingestion timing. Ingestion measures insertion,
then one final sync; explicit invalidations and their sync happen afterward and
are outside the reported insertion rate. It is not per-edge fsync.

| Order / API | Buffered versions/s | Including final sync | Journal bytes | Reopen s |
|---|---:|---:|---:|---:|
| batch-ordered | 1,106,939 | 1,104,833 | 698,050,224 | 10.645 |
| single-ordered | 547,763 | 547,251 | 978,022,224 | 13.763 |
| batch-shuffled | 942,518 | 941,933 | 682,626,544 | 12.910 |
| single-shuffled | 559,476 | 559,132 | 962,598,544 | 14.686 |

| Query | p50 ms | p99 ms |
|---|---:|---:|
| Fully consumed as-of, 200 timestamps after 10 warmups | 19.053 | 19.805 |
| Fully consumed between, 200 windows of 36 seconds | 22.812 | 23.782 |

LatestFirst: 27,686,055 returned edges/s. Uniform:
24,740,808 returned edges/s. Each sampler returned 17,747,039 edges
across 200 seeded timestamp batches of 10,000 nodes, k=10. Arrow export produced
949,342 rows in 31.187 ms including materialization.

| Target | Final result | Status |
|---|---:|---|
| Ordered single ≥500k/s including final sync | 547,251/s | PASS |
| Ordered batch ≥2M/s including final sync | 1,104,833/s | MISSED |
| Full as-of p50 <10 ms | 19.053 ms | MISSED |
| Returned sample ≥5M/s | Both >24M/s | PASS |

The misses remain visible in product copy and release status. A repeat on a
controlled machine/power configuration and a matched baseline is still needed
to attribute the difference. Do not claim the candidate meets every speed target.

Whole-run peak resident memory from macOS `/usr/bin/time -l`: ordered batch
3,491,495,936 bytes; ordered single 4,037,935,104; shuffled batch 3,641,016,320;
shuffled single 3,915,841,536. These peaks include generator, validation, replay
and close/snapshot work, not just the steady loaded graph. They are not cloud
memory sizing advice or the sum of all system processes.

## Criterion (separate statistical run)

| Workload | Estimate | Confidence interval |
|---|---:|---:|
| 10M full as-of traversal | 11.749 ms | 11.543–12.105 ms |
| 10M full 36-second between traversal | 21.791 ms | 21.037–22.599 ms |
| LatestFirst fixed timestamp | 60.182M returned edges/s | 59.791–60.484M/s |
| Uniform fixed timestamp | 70.535M returned edges/s | 70.228–70.784M/s |
| 100k single inserts + sync | 38.627 ms | 38.296–38.882 ms |
| 100k batches + sync | 32.792 ms | 32.749–32.836 ms |

Criterion estimates are not individual-query percentiles; its fixed sampling
timestamp and 100k ingestion workload differ from the 10M runner. Raw Criterion
output includes comparisons with old local caches; those are not a controlled
A/B test with matched power/host conditions.

## Examples and comparison

The one-million-version, 128-channel BCI example completed in 0.824 seconds,
1,213,640 versions/s including sync. It found its expected high-synchrony window.
The small world-model temporal replay/Arrow/reopen example also passed. The
100-durable-future example is separately reported in the phase-5 report; its toy
simulation compute time must not be presented as large-graph persistence latency.

Neo4j comparison remains **PENDING**: `docker info --format '{{.ServerVersion}}'`
did not respond within 8 seconds. The [comparison harness](neo4j/README.md) gives
exact commands. There are no fabricated Neo4j or cloud results.

## Reproduce and inspect

Build with `cargo build --locked --release --workspace --bins --examples`, then
run `python3 scripts/release/bench-final.py` from a fresh source checkout. It refuses
to overwrite `bench/data/v0.3.0/final`. Choose a different explicitly new run path
for another complete run. `bench/run.sh` is the general workload runner.

Raw CSVs, per-query samples, exact commands, environment, time/RSS output and
Criterion logs are in `bench/reports/v0.3.0/phase-8-release/`. The previous checkpoint
is in `phase-2/`. HTTP/MCP first-page timings and final durability latency use a
separate 100k-version loopback service workload documented in `docs/TESTING.md`.
