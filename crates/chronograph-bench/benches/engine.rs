use chronograph_bench::*;
use chronograph_db::{Graph, NodeId, SampleStrategy};
use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use std::{
    hint::black_box,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

fn benchmarks(c: &mut Criterion) {
    let count = configured_count();
    let path = data_path();
    assert!(
        path.exists(),
        "First run cargo run --release -p chronograph-bench --bin measure"
    );
    let graph = Graph::open(path).unwrap();
    assert_eq!(graph.stats().edge_versions, count);
    let times = timestamps(200);
    let mut queries = c.benchmark_group(format!("temporal_{count}_versions"));
    queries.sample_size(20);
    let mut cursor = 0;
    queries.bench_function("as_of_full_traversal", |b| {
        b.iter(|| {
            let t = times[cursor % times.len()];
            cursor += 1;
            black_box(
                graph
                    .as_of(black_box(t))
                    .edges()
                    .fold((0usize, 0u64), |(n, sum), e| {
                        (n + 1, sum.wrapping_add(e.id.0))
                    }),
            )
        })
    });
    queries.bench_function("between_full_traversal", |b| {
        b.iter(|| {
            let t = times[cursor % times.len()];
            cursor += 1;
            black_box(
                graph
                    .between(t, t + HOUR / 100)
                    .fold((0usize, 0u64), |(n, sum), e| {
                        (n + 1, sum.wrapping_add(e.id.0))
                    }),
            )
        })
    });
    queries.finish();
    let nodes: Vec<_> = (0..10_000)
        .map(|i| NodeId((i * 7919 % (count / 100)) as u64))
        .collect();
    let mut sampling = c.benchmark_group("sample_10k_k10");
    // A fixed seeded timestamp allows Criterion's throughput denominator to be exact;
    // the measurement runner separately varies timestamps and counts actual outputs.
    let t = times[0];
    let output = graph.sample_neighbors_seeded(&nodes, 10, t, SampleStrategy::LatestFirst, SEED);
    sampling.throughput(Throughput::Elements(
        output.iter().map(Vec::len).sum::<usize>() as u64,
    ));
    for strategy in [SampleStrategy::LatestFirst, SampleStrategy::Uniform] {
        sampling.bench_function(format!("{strategy:?}"), |b| {
            b.iter(|| {
                black_box(graph.sample_neighbors_seeded(
                    black_box(&nodes),
                    10,
                    black_box(t),
                    strategy,
                    SEED,
                ))
            })
        });
    }
    sampling.finish();
    drop(graph);
    let events = dataset(100_000.min(count), false);
    let mut group = c.benchmark_group(format!("ingest_{}_versions", events.len()));
    group.sample_size(10);
    group.throughput(Throughput::Elements(events.len() as u64));
    static RUN: AtomicU64 = AtomicU64::new(0);
    for batch in [false, true] {
        group.bench_function(
            if batch {
                "batch_10k_with_sync"
            } else {
                "single_with_sync"
            },
            |b| {
                b.iter_batched(
                    || {
                        let path = std::env::temp_dir().join(format!(
                            "chronograph-criterion-{}-{}.cgraph",
                            std::process::id(),
                            RUN.fetch_add(1, Ordering::Relaxed)
                        ));
                        let graph = Graph::open(&path).unwrap();
                        (graph, path)
                    },
                    |(mut graph, path)| {
                        for chunk in events.chunks(10_000) {
                            if batch {
                                let inputs: Vec<_> = chunk.iter().map(|e| e.input).collect();
                                black_box(graph.add_edges(&inputs).unwrap());
                            } else {
                                for event in chunk {
                                    let i = event.input;
                                    black_box(
                                        graph
                                            .add_edge(i.src, i.dst, i.kind, i.valid_from, i.payload)
                                            .unwrap(),
                                    );
                                }
                            }
                        }
                        graph.sync().unwrap();
                        // Return ownership so Criterion excludes graph destruction and file removal.
                        BenchFile(Some(graph), path)
                    },
                    BatchSize::LargeInput,
                )
            },
        );
    }
    group.finish();
}

struct BenchFile(Option<Graph>, std::path::PathBuf);
impl Drop for BenchFile {
    fn drop(&mut self) {
        self.0.take();
        let _ = std::fs::remove_file(&self.1);
    }
}
criterion_group! { name=benches; config=Criterion::default().warm_up_time(Duration::from_secs(1)).measurement_time(Duration::from_secs(3)); targets=benchmarks }
criterion_main!(benches);
