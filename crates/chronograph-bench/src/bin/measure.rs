use chronograph_bench::*;
use chronograph_db::{Graph, NodeId, SampleStrategy};
use std::{fs, hint::black_box, io::Write, time::Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let count = configured_count();
    let args: Vec<_> = std::env::args().collect();
    let single = args.iter().any(|a| a == "--single");
    let shuffled = args.iter().any(|a| a == "--shuffled");
    let reuse = args.iter().any(|a| a == "--reuse");
    let export = args.iter().any(|a| a == "--export");
    let query_only = args.iter().any(|a| a == "--query-only");
    let path = data_path();
    if !reuse && path.exists() {
        return Err(format!(
            "{} already exists; use --reuse or choose CHRONOGRAPH_BENCH_DB",
            path.display()
        )
        .into());
    }
    fs::create_dir_all(path.parent().unwrap())?;
    let report_dir = std::env::var_os("CHRONOGRAPH_BENCH_REPORT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| workspace_root().join("bench/results"));
    fs::create_dir_all(&report_dir)?;
    let mut mode = format!(
        "{}-{}",
        if single { "single" } else { "batch" },
        if shuffled { "shuffled" } else { "ordered" }
    );
    if count != 10_000_000 {
        mode.push_str(&format!("-{count}-versions"));
    }
    if reuse {
        mode.push_str("-query-rerun");
    }
    let mut report = fs::File::create(report_dir.join(format!("{mode}.csv")))?;
    writeln!(report, "metric,value,unit")?;
    println!(
        "dataset={count}, nodes={}, seed={SEED}, mode={mode}, rayon_threads={}",
        count / 100,
        rayon::current_num_threads()
    );
    if !reuse {
        let generated = Instant::now();
        let events = dataset(count, shuffled);
        println!("Generated in {:.3}s", generated.elapsed().as_secs_f64());
        let mut graph = Graph::open(&path)?;
        let (buffered, synced) = ingest(&mut graph, &events, !single);
        validate(&graph, &events);
        println!(
            "Ingest: {:.0} edges/s buffered, {:.0} edges/s including sync; {:.3}s / {:.3}s",
            count as f64 / buffered,
            count as f64 / synced,
            buffered,
            synced
        );
        writeln!(
            report,
            "ingest_buffered,{},edges/s",
            count as f64 / buffered
        )?;
        writeln!(report, "ingest_with_sync,{},edges/s", count as f64 / synced)?;
        writeln!(report, "log_size,{},bytes", graph.stats().log_bytes)?;
        if export {
            println!("Exporting reproducibility CSVs");
            export_dataset(path.parent().unwrap(), &events)?;
        }
        graph.close()?;
    }
    let opened = Instant::now();
    let graph = Graph::open(&path)?;
    println!(
        "Reopen: {:.3}s, {} versions, {} bytes",
        opened.elapsed().as_secs_f64(),
        graph.stats().edge_versions,
        graph.stats().log_bytes
    );
    writeln!(report, "reopen,{},seconds", opened.elapsed().as_secs_f64())?;
    assert_eq!(graph.stats().edge_versions, count);
    if !query_only && args.iter().any(|a| a == "--ingest-only") {
        return Ok(());
    }
    let times = timestamps(200);
    for &t in times.iter().take(10) {
        black_box(
            graph
                .as_of(t)
                .edges()
                .fold(0u64, |sum, e| sum.wrapping_add(e.id.0)),
        );
    }
    let mut samples = Vec::with_capacity(times.len());
    let mut latencies = fs::File::create(report_dir.join(format!("{mode}-latencies.csv")))?;
    writeln!(latencies, "t,elapsed_ns,count,checksum")?;
    for &t in &times {
        let started = Instant::now();
        let (rows, checksum) = graph.as_of(t).edges().fold((0usize, 0u64), |(n, sum), e| {
            (n + 1, sum.wrapping_add(e.id.0))
        });
        black_box((rows, checksum));
        let elapsed = started.elapsed();
        samples.push(elapsed.as_secs_f64() * 1000.0);
        writeln!(latencies, "{t},{},{rows},{checksum}", elapsed.as_nanos())?;
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "Full graph traversal: p50={:.3}ms p99={:.3}ms (200 individual queries)",
        samples[99], samples[197]
    );
    writeln!(report, "as_of_p50,{},ms", samples[99])?;
    writeln!(report, "as_of_p99,{},ms", samples[197])?;
    let mut windows = Vec::with_capacity(times.len());
    for &t in &times {
        let start = Instant::now();
        black_box(
            graph
                .between(t, t + HOUR / 100)
                .fold((0usize, 0u64), |(n, sum), e| {
                    (n + 1, sum.wrapping_add(e.id.0))
                }),
        );
        windows.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    windows.sort_by(f64::total_cmp);
    println!(
        "Between full traversal: p50={:.3}ms p99={:.3}ms",
        windows[99], windows[197]
    );
    writeln!(report, "between_p50,{},ms", windows[99])?;
    writeln!(report, "between_p99,{},ms", windows[197])?;
    let nodes: Vec<_> = (0..10_000)
        .map(|i| NodeId((i * 7919 % (count / 100)) as u64))
        .collect();
    for strategy in [SampleStrategy::LatestFirst, SampleStrategy::Uniform] {
        let started = Instant::now();
        let mut sampled = 0;
        for (seed, &t) in times.iter().enumerate() {
            let output = graph.sample_neighbors_seeded(&nodes, 10, t, strategy, seed as u64);
            sampled += output.iter().map(Vec::len).sum::<usize>();
            black_box(output);
        }
        let throughput = sampled as f64 / started.elapsed().as_secs_f64();
        println!("{strategy:?}: {throughput:.0} sampled edges/s ({sampled} outputs)");
        writeln!(report, "sample_{strategy:?},{throughput},edges/s")?;
    }
    let started = Instant::now();
    let arrow = graph.export_arrow(HOUR / 2)?;
    println!(
        "Arrow: {} rows in {:.3}ms",
        arrow.num_rows(),
        started.elapsed().as_secs_f64() * 1000.0
    );
    writeln!(
        report,
        "arrow_export,{},ms",
        started.elapsed().as_secs_f64() * 1000.0
    )?;
    report.flush()?;
    Ok(())
}
