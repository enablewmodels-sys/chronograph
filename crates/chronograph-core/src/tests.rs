use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
};

use arrow::{
    array::{Array, FixedSizeBinaryArray, UInt64Array},
    datatypes::DataType,
};
use proptest::prelude::*;
use rand::{Rng, SeedableRng, rngs::SmallRng};

use crate::storage::{Insert, Record, encode_record};
use crate::*;

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn bounded_batch_preserves_gaps_late_arrivals_atomicity_and_replay() {
    let f = TestFile::new();
    let mut graph = Graph::open(&f.0).unwrap();
    let item = |from, to| BoundedEdgeInput {
        edge: EdgeInput {
            src: NodeId(1),
            dst: NodeId(2),
            kind: EdgeKind(1),
            valid_from: from,
            payload: [0; 16],
        },
        valid_to: to,
    };
    let ids = graph
        .add_edges_bounded(&[item(10, 15), item(20, 25), item(17, 18), item(12, 13)])
        .unwrap();
    let expected: Vec<_> = graph
        .history()
        .iter()
        .map(|e| (e.valid_from, e.valid_to))
        .collect();
    assert_eq!(expected, vec![(10, 12), (20, 25), (17, 18), (12, 13)]);
    for t in [9, 13, 14, 15, 16, 18, 19, 25] {
        assert_eq!(graph.as_of(t).edges().count(), 0, "t={t}");
    }
    assert_eq!(graph.as_of(20).edges().next().unwrap().id, ids[1]);
    let revision = graph.revision();
    assert!(
        graph
            .add_edges_bounded(&[item(30, 40), item(50, 49)])
            .is_err()
    );
    assert_eq!(graph.revision(), revision);
    assert_eq!(graph.history().len(), 4);
    graph.close().unwrap();
    let graph = Graph::open(&f.0).unwrap();
    assert_eq!(
        graph
            .history()
            .iter()
            .map(|e| (e.valid_from, e.valid_to))
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(graph.revision(), revision);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn bounded_temporal_batches_match_reference(ops in prop::collection::vec((0u64..3, -50i64..150, 0i64..50), 1..100)) {
        let f = TestFile::new(); let mut graph = Graph::open(&f.0).unwrap(); let mut reference: Vec<Edge> = Vec::new();
        let inputs: Vec<_> = ops.into_iter().map(|(src,t,width)| BoundedEdgeInput { edge: EdgeInput { src: NodeId(src), dst: NodeId(10), kind: EdgeKind(2), valid_from:t, payload:[0;16] }, valid_to:t+width }).collect();
        for chunk in inputs.chunks(7) {
            graph.add_edges_bounded(chunk).unwrap();
            for input in chunk {
                let next = reference.iter().filter(|e| e.src == input.edge.src && e.valid_from > input.edge.valid_from).map(|e| e.valid_from).min().unwrap_or(i64::MAX);
                for old in reference.iter_mut().filter(|e| e.src == input.edge.src && e.is_valid_at(input.edge.valid_from)) { old.valid_to = input.edge.valid_from; }
                reference.push(Edge { id: EdgeId(reference.len() as u64), src: input.edge.src, dst: input.edge.dst, kind: input.edge.kind,
                    valid_from: input.edge.valid_from, valid_to: input.valid_to.min(next), payload: input.edge.payload });
            }
            prop_assert_eq!(graph.history(), reference.as_slice());
        }
        graph.close().unwrap(); let graph = Graph::open(&f.0).unwrap(); prop_assert_eq!(graph.history(), reference.as_slice());
        for t in -50..150 {
            let mut actual: Vec<_> = graph.as_of(t).edges().map(|e| e.id).collect(); actual.sort();
            let expected: Vec<_> = reference.iter().filter(|e| e.is_valid_at(t)).map(|e| e.id).collect();
            prop_assert_eq!(actual,expected);
        }
    }
}

#[test]
fn independently_encoded_v1_fixture_is_compatible() {
    let f = TestFile::new();
    let fixture = include_bytes!("../tests/fixtures/v1.cgraph");
    fs::write(&f.0, fixture).unwrap();
    assert!(matches!(Graph::open(&f.0), Err(Error::MigrationRequired)));
    let migrated = TestFile::new();
    Graph::migrate_v1(&f.0, &migrated.0).unwrap();
    let graph = Graph::open(&migrated.0).unwrap();
    assert!(graph.contains_node(NodeId(42)));
    assert_eq!(graph.history().len(), 2);
    assert_eq!(graph.edge(EdgeId(0)).unwrap().valid_to, 20);
    assert_eq!(graph.edge(EdgeId(1)).unwrap().valid_to, 25);
    assert_eq!(ids(&graph, 10), vec![EdgeId(0)]);
    assert_eq!(ids(&graph, 20), vec![EdgeId(1)]);
    assert!(ids(&graph, 25).is_empty());
    drop(graph);
    assert_eq!(fs::read(&f.0).unwrap(), fixture);
}

struct TestFile(PathBuf);
impl TestFile {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "chronograph-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        Self(dir.join("graph.cgraph"))
    }
}
impl Drop for TestFile {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.parent().unwrap());
    }
}

fn input(src: u64, dst: u64, t: i64) -> EdgeInput {
    EdgeInput {
        src: NodeId(src),
        dst: NodeId(dst),
        kind: EdgeKind(0),
        valid_from: t,
        payload: [t as u8; 16],
    }
}
fn add(g: &mut Graph, i: EdgeInput) -> EdgeId {
    g.add_edge(i.src, i.dst, i.kind, i.valid_from, i.payload)
        .unwrap()
}
fn ids(g: &Graph, t: i64) -> Vec<EdgeId> {
    let mut result: Vec<_> = g.as_of(t).edges().map(|e| e.id).collect();
    result.sort_unstable();
    result
}

#[test]
fn interval_math_and_late_replacement() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    g.add_node(NodeId(99)).unwrap();
    g.add_node(NodeId(99)).unwrap();
    let a = add(&mut g, input(1, 2, 10));
    let c = add(&mut g, input(1, 2, 30));
    let b = add(&mut g, input(1, 2, 20));
    assert_eq!(g.edge(a).unwrap().valid_to, 20);
    assert_eq!(g.edge(b).unwrap().valid_to, 30);
    assert_eq!(ids(&g, 9), vec![]);
    assert_eq!(ids(&g, 10), vec![a]);
    assert_eq!(ids(&g, 20), vec![b]);
    assert_eq!(ids(&g, 30), vec![c]);
    assert!(ids(&g, i64::MAX).is_empty());
    let equal = add(&mut g, input(1, 2, 20));
    assert_eq!(g.edge(b).unwrap().valid_to, 20);
    assert_eq!(ids(&g, 20), vec![equal]);
    assert_eq!(
        g.between(20, 30).map(|e| e.id).collect::<Vec<_>>(),
        vec![equal]
    );
    assert_eq!(g.between(30, 30).count(), 0);
    assert_eq!(g.between(30, 10).count(), 0);
    g.invalidate_edge(equal, 25).unwrap();
    g.invalidate_edge(equal, 28).unwrap();
    assert_eq!(g.edge(equal).unwrap().valid_to, 25);
    assert!(ids(&g, 25).is_empty());
    assert!(matches!(
        g.invalidate_edge(equal, 19),
        Err(Error::InvalidTimestamp(19))
    ));
    assert!(matches!(
        g.invalidate_edge(EdgeId(800), 20),
        Err(Error::UnknownEdge(_))
    ));
    assert!(matches!(
        g.add_edge(NodeId(0), NodeId(0), EdgeKind(0), i64::MAX, [0; 16]),
        Err(Error::InvalidTimestamp(_))
    ));
    add(&mut g, input(5, 5, i64::MIN));
    assert_eq!(g.neighbors(NodeId(5), i64::MIN).count(), 1);
    assert!(g.contains_node(NodeId(99)));
    assert!(g.contains_node(NodeId(2)));
    let expected = g.history().to_vec();
    g.close().unwrap();
    let reopened = Graph::open(&f.0).unwrap();
    assert_eq!(reopened.history(), expected);
    assert!(reopened.contains_node(NodeId(99)));
}

#[test]
fn late_event_fills_gap_without_changing_successor() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    let first = add(&mut g, input(0, 1, 0));
    g.invalidate_edge(first, 5).unwrap();
    let last = add(&mut g, input(0, 1, 20));
    let middle = add(&mut g, input(0, 1, 10));
    assert_eq!(g.edge(first).unwrap().valid_to, 5);
    assert_eq!(g.edge(middle).unwrap().valid_to, 20);
    assert_eq!(ids(&g, 20), vec![last]);
}

#[test]
fn batches_match_sequential_and_reject_invalid_input_atomically() {
    let a = TestFile::new();
    let b = TestFile::new();
    let mut seq = Graph::open(&a.0).unwrap();
    let mut batch = Graph::open(&b.0).unwrap();
    let mut rng = SmallRng::seed_from_u64(33);
    let inputs: Vec<_> = (0..3000)
        .map(|_| {
            input(
                rng.random_range(0..8),
                rng.random_range(0..10),
                rng.random_range(-10..100),
            )
        })
        .collect();
    for chunk in inputs.chunks(137) {
        let expected: Vec<_> = chunk.iter().map(|&i| add(&mut seq, i)).collect();
        assert_eq!(batch.add_edges(chunk).unwrap(), expected);
    }
    assert_eq!(seq.history(), batch.history());
    let before = batch.stats().log_bytes;
    assert!(
        batch
            .add_edges(&[input(40, 41, 0), input(40, 41, i64::MAX)])
            .is_err()
    );
    assert_eq!(before, batch.stats().log_bytes);
    assert!(!batch.contains_node(NodeId(40)));
    assert!(batch.add_edges(&[]).unwrap().is_empty());
    let expected = batch.history().to_vec();
    batch.close().unwrap();
    let reopened = Graph::open(&b.0).unwrap();
    assert_eq!(reopened.history(), expected);
    for t in -10..110 {
        assert_eq!(ids(&seq, t), ids(&reopened, t));
    }
}

#[test]
fn sampling_and_temporal_filtering() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    for t in 0..200 {
        let id = add(&mut g, input(0, 1, t));
        g.invalidate_edge(id, t + 1).unwrap();
    }
    for dst in 10..30 {
        add(&mut g, input(0, dst, 200));
    }
    assert_eq!(g.neighbors(NodeId(0), 100).count(), 1);
    let latest = g.sample_neighbors(
        &[NodeId(0), NodeId(999)],
        5,
        200,
        SampleStrategy::LatestFirst,
    );
    assert_eq!(
        latest[0].iter().map(|r| r.id.0).collect::<Vec<_>>(),
        vec![219, 218, 217, 216, 215]
    );
    assert!(latest[1].is_empty());
    assert!(g.sample_neighbors(&[NodeId(0)], 0, 200, SampleStrategy::Uniform)[0].is_empty());
    for strategy in [SampleStrategy::Uniform, SampleStrategy::LatestFirst] {
        let sample = g.sample_neighbors_seeded(&[NodeId(0); 4], 100, 200, strategy, 7);
        assert_eq!(sample[0].len(), 20);
        for row in sample {
            let unique: std::collections::HashSet<_> = row.iter().collect();
            assert_eq!(unique.len(), row.len());
        }
    }
    let run = || g.sample_neighbors_seeded(&[NodeId(0); 100], 5, 200, SampleStrategy::Uniform, 777);
    let one = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap()
        .install(run);
    let four = rayon::ThreadPoolBuilder::new()
        .num_threads(4)
        .build()
        .unwrap()
        .install(run);
    assert_eq!(one, four);
    let mut frequencies = [0usize; 20];
    for seed in 0..4000 {
        let row = g.sample_neighbors_seeded(&[NodeId(0)], 1, 200, SampleStrategy::Uniform, seed);
        frequencies[(row[0][0].id.0 - 200) as usize] += 1;
    }
    assert!(
        frequencies.into_iter().all(|n| (130..270).contains(&n)),
        "gross sampling bias"
    );
}

#[test]
fn arrow_export_and_parallel_reads() {
    fn send_sync<T: Send + Sync>() {}
    send_sync::<Graph>();
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(1, 2, 0));
    add(&mut g, input(1, 2, 10));
    let batch = g.export_arrow(5).unwrap();
    assert_eq!(batch.num_rows(), 1);
    assert_eq!(batch.num_columns(), 6);
    assert_eq!(
        batch.schema().field(5).data_type(),
        &DataType::FixedSizeBinary(16)
    );
    assert!(batch.schema().fields().iter().all(|f| !f.is_nullable()));
    assert_eq!(
        batch
            .column(0)
            .as_any()
            .downcast_ref::<UInt64Array>()
            .unwrap()
            .value(0),
        1
    );
    assert_eq!(
        batch
            .column(5)
            .as_any()
            .downcast_ref::<FixedSizeBinaryArray>()
            .unwrap()
            .value(0),
        &[0; 16]
    );
    let empty = g.export_arrow(-1).unwrap();
    assert_eq!(empty.num_rows(), 0);
    std::thread::scope(|scope| {
        for _ in 0..8 {
            let graph = &g;
            scope.spawn(move || {
                for _ in 0..100 {
                    assert_eq!(graph.as_of(5).edges().count(), 1);
                    assert_eq!(graph.export_arrow(10).unwrap().num_rows(), 1);
                }
            });
        }
    });
}

#[test]
fn lock_and_sync_mode() {
    let f = TestFile::new();
    let mut g = Graph::open_with_options(
        &f.0,
        OpenOptions {
            durability: Durability::Fsync,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(matches!(Graph::open(&f.0), Err(Error::Locked)));
    add(&mut g, input(1, 2, 0));
    assert_eq!(fs::metadata(&f.0).unwrap().len(), g.stats().log_bytes);
    g.close().unwrap();
    assert_eq!(Graph::open(&f.0).unwrap().stats().edge_versions, 1);
}

#[test]
fn failed_sync_disables_writer_and_requires_reopen() {
    let f = TestFile::new();
    let mut graph = Graph::open_with_options(
        &f.0,
        OpenOptions {
            durability: Durability::Fsync,
            ..Default::default()
        },
    )
    .unwrap();
    graph.journal.fault_sync = true;
    assert!(
        graph
            .add_edges(&[input(1, 2, 10), input(1, 2, 20)])
            .is_err()
    );
    assert!(graph.history().is_empty());
    assert!(matches!(graph.sync(), Err(Error::WriterFailed)));
    drop(graph);
    // A failed sync is ambiguous: fully appended operations may survive. They remain atomic.
    let reopened = Graph::open(&f.0).unwrap();
    assert_eq!(reopened.history().len(), 2);
    assert_eq!(reopened.edge(EdgeId(0)).unwrap().valid_to, 20);
}

#[test]
fn corrupted_length_cannot_hide_later_records_as_a_torn_tail() {
    let f = TestFile::new();
    let mut graph = Graph::open(&f.0).unwrap();
    add(&mut graph, input(1, 2, 10));
    add(&mut graph, input(1, 2, 20));
    graph.close().unwrap();
    let mut bytes = fs::read(&f.0).unwrap();
    bytes[12..16].copy_from_slice(&4096u32.to_le_bytes());
    fs::write(&f.0, &bytes).unwrap();
    assert!(matches!(Graph::open(&f.0), Err(Error::Corrupt { .. })));
    assert_eq!(fs::read(&f.0).unwrap(), bytes);
}

#[test]
fn partial_append_every_byte_preserves_atomic_replacement() {
    let baseline = TestFile::new();
    let mut g = Graph::open(&baseline.0).unwrap();
    let first = add(&mut g, input(1, 2, 0));
    g.close().unwrap();
    let bytes = fs::read(&baseline.0).unwrap();
    let insert = Insert {
        edge: Edge {
            id: EdgeId(1),
            src: NodeId(1),
            dst: NodeId(2),
            kind: EdgeKind(0),
            valid_from: 10,
            valid_to: i64::MAX,
            payload: [10; 16],
        },
        predecessor: Some(first),
    };
    let mut frame = Vec::new();
    encode_record(&Record::Batch(vec![insert]), &mut frame).unwrap();
    for split in 0..frame.len() {
        let f = TestFile::new();
        fs::write(&f.0, &bytes).unwrap();
        let mut graph = Graph::open(&f.0).unwrap();
        graph.journal.fault_after = Some(split);
        assert!(graph.add_edges(&[input(1, 2, 10)]).is_err());
        assert_eq!(graph.history().len(), 1);
        assert!(matches!(
            graph.add_node(NodeId(7)),
            Err(Error::WriterFailed)
        ));
        drop(graph);
        let reopened = Graph::open(&f.0).unwrap();
        assert_eq!(reopened.history().len(), 1, "split={split}");
        assert_eq!(reopened.edge(first).unwrap().valid_to, i64::MAX);
        assert_eq!(fs::metadata(&f.0).unwrap().len(), bytes.len() as u64);
    }
}

#[test]
fn corruption_and_format_errors_do_not_rewrite_files() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(0, 1, 0));
    add(&mut g, input(0, 2, 1));
    g.close().unwrap();
    let original = fs::read(&f.0).unwrap();
    let mut corrupt = original.clone();
    corrupt[30] ^= 1;
    fs::write(&f.0, &corrupt).unwrap();
    assert!(matches!(Graph::open(&f.0), Err(Error::Corrupt { .. })));
    assert_eq!(fs::read(&f.0).unwrap(), corrupt);
    let mut future = original.clone();
    future[8..12].copy_from_slice(&99u32.to_le_bytes());
    fs::write(&f.0, &future).unwrap();
    assert!(matches!(
        Graph::open(&f.0),
        Err(Error::UnsupportedFormat(_))
    ));
    assert_eq!(fs::read(&f.0).unwrap(), future);
    let mut invalid_len = original.clone();
    invalid_len[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    fs::write(&f.0, &invalid_len).unwrap();
    assert!(matches!(Graph::open(&f.0), Err(Error::Corrupt { .. })));
    let mut unknown = original.clone();
    unknown[22..24].copy_from_slice(&99u16.to_le_bytes());
    let len = u32::from_le_bytes(unknown[12..16].try_into().unwrap()) as usize;
    let end = 20 + len;
    let checksum = crc32fast::hash(&unknown[20..end - 4]);
    unknown[end - 4..end].copy_from_slice(&checksum.to_le_bytes());
    fs::write(&f.0, &unknown).unwrap();
    assert!(matches!(
        Graph::open(&f.0),
        Err(Error::UnsupportedFormat(_))
    ));
    assert_eq!(fs::read(&f.0).unwrap(), unknown);
}

#[test]
fn partial_header_and_trailing_checksum_recovery() {
    for size in 0..12 {
        let f = TestFile::new();
        let header = b"CHROGRPH\x03\0\0\0";
        fs::write(&f.0, &header[..size]).unwrap();
        let g = Graph::open(&f.0).unwrap();
        assert_eq!(g.stats().log_bytes, 12);
    }
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(1, 2, 0));
    g.close().unwrap();
    let mut bytes = fs::read(&f.0).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fs::write(&f.0, &bytes).unwrap();
    assert_eq!(Graph::open(&f.0).unwrap().history().len(), 0);
}

#[test]
#[ignore = "subprocess-only crash writer"]
fn crash_child() {
    let path = std::env::var_os("CHRONOGRAPH_CRASH_PATH").expect("child path");
    let mut g = Graph::open(path).unwrap();
    g.journal.fault_after = Some(43);
    assert!(g.add_edges(&[input(1, 2, 100), input(2, 3, 100)]).is_err());
    println!("FAULT_WRITTEN");
    std::io::stdout().flush().unwrap();
    loop {
        std::thread::park();
    }
}

#[test]
fn kill_mid_append_recovers_whole_operations() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(1, 2, 0));
    g.close().unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "tests::crash_child", "--ignored", "--nocapture"])
        .env("CHRONOGRAPH_CRASH_PATH", &f.0)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut reader = BufReader::new(child.stdout.take().unwrap());
    loop {
        let mut line = String::new();
        assert!(
            reader.read_line(&mut line).unwrap() > 0,
            "child exited before fault"
        );
        if line.contains("FAULT_WRITTEN") {
            break;
        }
    }
    child.kill().unwrap();
    child.wait().unwrap();
    let mut g = Graph::open(&f.0).unwrap();
    assert_eq!(g.history().len(), 1);
    assert_eq!(g.edge(EdgeId(0)).unwrap().valid_to, i64::MAX);
    assert_eq!(g.stats().recovered_tail_bytes, 43);
    add(&mut g, input(1, 2, 50));
    g.close().unwrap();
    assert_eq!(Graph::open(&f.0).unwrap().history().len(), 2);
}

// Independent oracle: scan all existing versions instead of consulting graph indexes.
fn naive_add(edges: &mut Vec<Edge>, i: EdgeInput) {
    let same = |e: &Edge| (e.src, e.dst, e.kind) == (i.src, i.dst, i.kind);
    let end = edges
        .iter()
        .filter(|e| same(e) && e.valid_from > i.valid_from)
        .map(|e| e.valid_from)
        .min()
        .unwrap_or(i64::MAX);
    for e in edges.iter_mut() {
        if same(e) && e.valid_from <= i.valid_from && i.valid_from < e.valid_to {
            e.valid_to = i.valid_from;
        }
    }
    edges.push(Edge {
        id: EdgeId(edges.len() as u64),
        src: i.src,
        dst: i.dst,
        kind: i.kind,
        valid_from: i.valid_from,
        valid_to: end,
        payload: i.payload,
    });
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn arbitrary_history_matches_naive_model(ops in prop::collection::vec((0u8..5,0u64..8,0u64..8,-100i64..101),1..180), seed in any::<u64>()) {
        let f=TestFile::new(); let mut g=Graph::open(&f.0).unwrap(); let mut naive=Vec::new();
        for (op,src,dst,t) in ops {
            if op==0 && !naive.is_empty() {
                let n=src as usize%naive.len(); let e:&mut Edge=&mut naive[n];
                let result=g.invalidate_edge(e.id,t);
                if t<e.valid_from { prop_assert!(result.is_err()); }
                else { result.unwrap(); e.valid_to=e.valid_to.min(t); }
            } else { let i=input(src,dst,t); add(&mut g,i); naive_add(&mut naive,i); }
        }
        prop_assert_eq!(g.history(),naive.as_slice());
        g.close().unwrap(); let g=Graph::open(&f.0).unwrap();
        let mut rng=SmallRng::seed_from_u64(seed);
        for _ in 0..200 {
            let t=rng.random_range(-110..120);
            let expected:Vec<_>=naive.iter().filter(|e|e.valid_from<=t&&t<e.valid_to).map(|e|e.id).collect();
            prop_assert_eq!(ids(&g,t),expected);
            let node=NodeId(rng.random_range(0..8));
            let mut observed:Vec<_>=g.neighbors(node,t).map(|r|r.id).collect(); observed.sort_unstable();
            let expected:Vec<_>=naive.iter().filter(|e|e.src==node&&e.valid_from<=t&&t<e.valid_to).map(|e|e.id).collect();
            prop_assert_eq!(observed,expected);
            let end=t+rng.random_range(0..30);
            let expected:Vec<_>=naive.iter().filter(|e|t<end&&e.valid_from<e.valid_to&&e.valid_from<end&&e.valid_to>t).copied().collect();
            prop_assert_eq!(g.between(t,end).collect::<Vec<_>>(),expected);
        }
    }
}

#[test]
fn migration_rejects_existing_locked_and_incomplete_files() {
    let source = TestFile::new();
    let destination = TestFile::new();
    let fixture = include_bytes!("../tests/fixtures/v1.cgraph");
    fs::write(&source.0, fixture).unwrap();
    fs::write(&destination.0, b"do not overwrite").unwrap();
    assert!(Graph::migrate_v1(&source.0, &destination.0).is_err());
    assert_eq!(fs::read(&destination.0).unwrap(), b"do not overwrite");
    fs::remove_file(&destination.0).unwrap();
    let file = fs::File::open(&source.0).unwrap();
    file.lock().unwrap();
    assert!(matches!(
        Graph::migrate_v1(&source.0, &destination.0),
        Err(Error::Locked)
    ));
    assert!(!destination.0.exists());
    drop(file);
    for size in [0, 7, 11, fixture.len() - 1] {
        fs::write(&source.0, &fixture[..size]).unwrap();
        assert!(Graph::migrate_v1(&source.0, &destination.0).is_err());
        assert!(!destination.0.exists());
        assert_eq!(fs::read(&source.0).unwrap(), &fixture[..size]);
    }
}

#[test]
fn application_revision_and_drop_durability() {
    let file = TestFile::new();
    let mut graph = Graph::open(&file.0).unwrap();
    assert_eq!(graph.revision(), 0);
    assert_eq!(
        graph.apply(WriteOp::AddNode(NodeId(99))).unwrap(),
        WriteResult::Node(NodeId(99))
    );
    graph.add_node(NodeId(99)).unwrap();
    assert_eq!(graph.revision(), 1);
    let result = graph
        .apply(WriteOp::AddEdges(vec![input(1, 2, 0), input(1, 2, 10)]))
        .unwrap();
    assert_eq!(result, WriteResult::Edges(vec![EdgeId(0), EdgeId(1)]));
    graph.invalidate_edge(EdgeId(1), 20).unwrap();
    assert_eq!(graph.view().revision(), 3);
    drop(graph);
    let reopened = Graph::open(&file.0).unwrap();
    assert_eq!(reopened.revision(), 3);
    assert_eq!(reopened.edge(EdgeId(1)).unwrap().valid_to, 20);
}

#[test]
fn codec_rejects_unbounded_counts_and_invalid_options() {
    let baseline = TestFile::new();
    let mut graph = Graph::open(&baseline.0).unwrap();
    add(&mut graph, input(1, 2, 0));
    graph.close().unwrap();
    let bytes = fs::read(&baseline.0).unwrap();
    // A batch payload begins with its bounded u64 count; manufacture a checksummed
    // hostile record, so this tests the decoder rather than checksum rejection.
    for mutation in [0, 1] {
        let file = TestFile::new();
        let mut changed = bytes.clone();
        if mutation == 0 {
            changed[28..36].copy_from_slice(&u64::MAX.to_le_bytes());
        } else {
            changed[94] = 2;
        } // first Insert's optional predecessor discriminant
        let checksum = crc32fast::hash(&changed[20..changed.len() - 4]);
        let end = changed.len();
        changed[end - 4..].copy_from_slice(&checksum.to_le_bytes());
        fs::write(&file.0, &changed).unwrap();
        assert!(matches!(Graph::open(&file.0), Err(Error::Corrupt { .. })));
        assert_eq!(fs::read(&file.0).unwrap(), changed);
    }
}

#[test]
fn durable_forks_freeze_state_isolate_writes_and_remap_on_merge() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    g.add_node(NodeId(90)).unwrap();
    add(&mut g, input(1, 2, 0));
    let parent_revision = g.parent_revision();
    let a = g.fork_named(10, "candidate A").unwrap();
    let b = g.fork(10).unwrap();
    assert_eq!(g.parent_revision(), parent_revision);
    assert_eq!(g.fork_view(a, 10).unwrap().nodes().count(), 3);
    assert!(matches!(g.fork_view(a, 9), Err(Error::InvalidTimestamp(9))));
    assert!(g.add_edges_to_fork(a, &[input(1, 2, 9)]).is_err());
    // Shorten an inherited version, then insert after a gap. Merge must not refill the gap.
    g.write_fork(a, ForkWriteOp::Invalidate(EdgeId(0), 20))
        .unwrap();
    let delta = g
        .add_edges_to_fork(a, &[input(1, 2, 30), input(1, 700, 40)])
        .unwrap();
    g.write_fork(a, ForkWriteOp::AddNode(NodeId(701))).unwrap();
    assert_eq!(delta, [EdgeId(1), EdgeId(2)]);
    assert_eq!(g.as_of(25).edges().count(), 1);
    assert_eq!(g.fork_view(a, 25).unwrap().edges().count(), 0);
    assert_eq!(
        g.fork_view(b, 50).unwrap().edges().next().unwrap().payload,
        [0; 16]
    );
    assert_eq!(
        g.fork_view(a, 50)
            .unwrap()
            .neighbors(NodeId(1))
            .iter()
            .map(|e| e.id)
            .collect::<Vec<_>>(),
        [EdgeId(2), EdgeId(1)]
    );
    assert_eq!(
        g.fork_view(a, 50)
            .unwrap()
            .export_arrow()
            .unwrap()
            .num_rows(),
        2
    );
    let expected: Vec<_> = g.fork_history(a).unwrap().collect();
    let before = g.revision();
    g.close().unwrap();
    let mut g = Graph::open(&f.0).unwrap();
    assert_eq!(g.revision(), before);
    assert_eq!(g.fork_history(a).unwrap().collect::<Vec<_>>(), expected);
    let merged = g.merge(a).unwrap();
    assert_eq!(g.revision(), before + 1);
    assert_eq!(merged.parent_revision, parent_revision + 1);
    assert_eq!(
        merged.nodes,
        [
            NodeRemap {
                branch: NodeId(700),
                parent: NodeId(0)
            },
            NodeRemap {
                branch: NodeId(701),
                parent: NodeId(3)
            }
        ]
    );
    assert_eq!(merged.edges.len(), 3);
    assert!(g.contains_node(NodeId(3)));
    assert!(!g.contains_node(NodeId(700)));
    assert_eq!(g.as_of(25).edges().count(), 0);
    assert_eq!(g.edge(EdgeId(0)).unwrap().valid_to, 20);
    assert_eq!(g.edge(EdgeId(2)).unwrap().dst, NodeId(0));
    assert_eq!(g.edge(EdgeId(2)).unwrap().payload, [40; 16]);
    assert!(matches!(g.merge(b), Err(Error::ForkConflict(_))));
    assert!(matches!(g.fork_history(a), Err(Error::ForkClosed(_))));
    let rev = g.revision();
    assert_eq!(g.merge(a).unwrap(), merged);
    assert_eq!(g.revision(), rev);
    g.discard(b).unwrap();
    g.discard(b).unwrap();
    assert!(g.add_edges_to_fork(b, &[input(1, 2, 50)]).is_err());
    assert!(g.discard(a).is_err());
    g.close().unwrap();
    let mut g = Graph::open(&f.0).unwrap();
    assert_eq!(g.merge(a).unwrap(), merged);
    assert_eq!(g.fork_info(b).unwrap().status, ForkStatus::Discarded);
    assert_eq!(g.fork(50).unwrap(), ForkId(3));
}

#[test]
fn frozen_forks_exclude_parent_future_and_reject_conflicting_merges() {
    for finite_expiry in [false, true] {
        let f = TestFile::new();
        let mut g = Graph::open(&f.0).unwrap();
        add(&mut g, input(1, 2, 0));
        if finite_expiry {
            g.invalidate_edge(EdgeId(0), 100).unwrap();
        } else {
            add(&mut g, input(1, 2, 100));
        }
        let fork = g.fork(10).unwrap();
        assert_eq!(g.fork_history(fork).unwrap().count(), 1);
        assert_eq!(
            g.fork_view(fork, 200)
                .unwrap()
                .edges()
                .next()
                .unwrap()
                .payload,
            [0; 16]
        );
        g.add_edges_to_fork(fork, &[input(1, 2, 20)]).unwrap();
        let before = (g.revision(), g.stats().log_bytes, g.history().to_vec());
        assert!(matches!(g.merge(fork), Err(Error::ForkConflict(_))));
        assert_eq!(
            (g.revision(), g.stats().log_bytes, g.history().to_vec()),
            before
        );
        assert_eq!(g.fork_info(fork).unwrap().status, ForkStatus::Active);
        // An untouched relationship's future does not prevent merging an independent change.
        let independent = g.fork(10).unwrap();
        g.add_edges_to_fork(independent, &[input(1, 90, 20)])
            .unwrap();
        g.merge(independent).unwrap();
        assert_eq!(g.edge(EdgeId(0)).unwrap().valid_to, 100);
    }
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(1, 2, 0));
    let fork = g.fork(10).unwrap();
    add(&mut g, input(1, 2, 20));
    assert_eq!(
        g.fork_view(fork, 30)
            .unwrap()
            .edges()
            .next()
            .unwrap()
            .payload,
        [0; 16]
    );
    assert!(matches!(g.merge(fork), Err(Error::ForkConflict(_))));
    g.close().unwrap();
    let g = Graph::open(&f.0).unwrap();
    assert_eq!(
        g.fork_view(fork, 30)
            .unwrap()
            .edges()
            .next()
            .unwrap()
            .payload,
        [0; 16]
    );
}

#[test]
fn every_truncated_branch_operation_recovers_atomically() {
    // Cover every byte boundary of each new record type using actual encoded appends.
    for operation in 0..6 {
        let f = TestFile::new();
        let mut g = Graph::open(&f.0).unwrap();
        add(&mut g, input(1, 2, 0));
        let fork = g.fork(10).unwrap();
        g.add_edges_to_fork(fork, &[input(1, 2, 20), input(1, 9, 30)])
            .unwrap();
        g.sync().unwrap();
        let baseline = fs::read(&f.0).unwrap();
        let before_revision = g.revision();
        let before_parent = g.history().to_vec();
        let before_branch: Vec<_> = g.fork_history(fork).unwrap().collect();
        let op = match operation {
            0 => WriteOp::Fork {
                timestamp: 10,
                name: "another".into(),
            },
            1 => WriteOp::ForkWrite {
                fork,
                operation: ForkWriteOp::AddNode(NodeId(99)),
            },
            2 => WriteOp::ForkWrite {
                fork,
                operation: ForkWriteOp::AddEdges(vec![input(1, 2, 40), input(9, 2, 50)]),
            },
            3 => WriteOp::ForkWrite {
                fork,
                operation: ForkWriteOp::Invalidate(EdgeId(1), 25),
            },
            4 => WriteOp::DiscardFork(fork),
            _ => WriteOp::MergeFork(fork),
        };
        g.apply(op.clone()).unwrap();
        g.close().unwrap();
        let frame_len = fs::metadata(&f.0).unwrap().len() as usize - baseline.len();
        for split in 0..frame_len {
            let out = TestFile::new();
            fs::write(&out.0, &baseline).unwrap();
            let mut graph = Graph::open(&out.0).unwrap();
            graph.journal.fault_after = Some(split);
            assert!(
                graph.apply(op.clone()).is_err(),
                "op={operation} split={split}"
            );
            assert_eq!(graph.revision(), before_revision);
            assert_eq!(graph.history(), before_parent);
            assert_eq!(
                graph.fork_history(fork).unwrap().collect::<Vec<_>>(),
                before_branch
            );
            assert!(matches!(graph.fork(10), Err(Error::WriterFailed)));
            drop(graph);
            let graph = Graph::open(&out.0).unwrap();
            assert_eq!(graph.revision(), before_revision);
            assert_eq!(graph.history(), before_parent);
            assert_eq!(
                graph.fork_history(fork).unwrap().collect::<Vec<_>>(),
                before_branch
            );
            assert_eq!(fs::metadata(&out.0).unwrap().len() as usize, baseline.len());
        }
    }
}

#[test]
fn failed_merge_sync_has_atomic_recoverable_result() {
    let f = TestFile::new();
    let mut g = Graph::open_with_options(
        &f.0,
        OpenOptions {
            durability: Durability::Fsync,
            ..Default::default()
        },
    )
    .unwrap();
    add(&mut g, input(1, 2, 0));
    let fork = g.fork(10).unwrap();
    g.add_edges_to_fork(fork, &[input(1, 2, 20)]).unwrap();
    g.journal.fault_sync = true;
    assert!(g.merge(fork).is_err());
    assert_eq!(g.fork_info(fork).unwrap().status, ForkStatus::Active);
    assert_eq!(g.history().len(), 1);
    drop(g);
    let mut g = Graph::open(&f.0).unwrap();
    assert_eq!(g.fork_info(fork).unwrap().status, ForkStatus::Merged);
    assert_eq!(g.history().len(), 2);
    let rev = g.revision();
    assert_eq!(g.merge(fork).unwrap().edges.len(), 2);
    assert_eq!(g.revision(), rev);
}

#[test]
fn malformed_branch_records_never_rewrite_the_source() {
    let f = TestFile::new();
    let mut g = Graph::open(&f.0).unwrap();
    add(&mut g, input(1, 2, 0));
    let fork = g.fork(10).unwrap();
    let parent_revision = g.parent_revision();
    g.close().unwrap();
    let baseline = fs::read(&f.0).unwrap();
    let invalid = vec![
        Record::ForkCreate {
            id: ForkId(2),
            parent_revision: parent_revision + 1,
            timestamp: 10,
            name: "bad".into(),
        },
        Record::ForkCreate {
            id: ForkId(2),
            parent_revision,
            timestamp: 10,
            name: " bad ".into(),
        },
        Record::ForkNode(ForkId(99), NodeId(4)),
        Record::ForkNode(fork, NodeId(1)),
        Record::ForkBatch(fork, vec![]),
        Record::ForkBatch(
            fork,
            vec![Insert {
                edge: Edge {
                    id: EdgeId(1),
                    src: NodeId(1),
                    dst: NodeId(2),
                    kind: EdgeKind(0),
                    valid_from: 20,
                    valid_to: i64::MAX,
                    payload: [0; 16],
                },
                predecessor: None,
            }],
        ),
        Record::ForkInvalidate(fork, EdgeId(0), 9),
        Record::ForkDiscard(ForkId(99)),
        Record::ForkMerge(crate::storage::MergeData {
            fork,
            nodes: vec![],
            inserts: vec![],
            invalidations: vec![(EdgeId(0), 20)],
        }),
    ];
    for record in invalid {
        let mut bytes = baseline.clone();
        let mut frame = Vec::new();
        encode_record(&record, &mut frame).unwrap();
        bytes.extend(frame);
        fs::write(&f.0, &bytes).unwrap();
        assert!(matches!(Graph::open(&f.0), Err(Error::Corrupt { .. })));
        assert_eq!(fs::read(&f.0).unwrap(), bytes);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn branch_batches_and_merge_match_reference(ops in prop::collection::vec((1u64..4, 10i64..100, 0i64..30), 1..80)) {
        let f = TestFile::new(); let mut g = Graph::open(&f.0).unwrap();
        let mut reference = vec![];
        for src in 1..4 { add(&mut g, input(src,9,0)); }
        reference.extend_from_slice(g.history());
        let fork = g.fork(10).unwrap();
        let parent = g.history().to_vec();
        let inputs: Vec<_> = ops.into_iter().map(|(src,t,width)| BoundedEdgeInput {edge:input(src,9,t),valid_to:t+width}).collect();
        for chunk in inputs.chunks(5) {
            g.add_bounded_edges_to_fork(fork,chunk).unwrap();
            for input in chunk {
                let next = reference.iter().filter(|e|e.src==input.edge.src && e.valid_from>input.edge.valid_from).map(|e|e.valid_from).min().unwrap_or(i64::MAX);
                for old in reference.iter_mut().filter(|e|e.src==input.edge.src && e.is_valid_at(input.edge.valid_from)) {old.valid_to=input.edge.valid_from;}
                reference.push(Edge {id:EdgeId(reference.len() as u64),src:input.edge.src,dst:input.edge.dst,kind:input.edge.kind,valid_from:input.edge.valid_from,valid_to:input.valid_to.min(next),payload:input.edge.payload});
            }
            prop_assert_eq!(&g.fork_history(fork).unwrap().collect::<Vec<_>>(), &reference);
            prop_assert_eq!(g.history(), &parent);
        }
        let revision = g.revision(); g.close().unwrap(); let mut g = Graph::open(&f.0).unwrap();
        prop_assert_eq!(g.revision(),revision);
        for t in 10..140 {
            prop_assert_eq!(g.fork_view(fork,t).unwrap().edges().collect::<Vec<_>>(),reference.iter().filter(|e|e.is_valid_at(t)).copied().collect::<Vec<_>>());
        }
        g.merge(fork).unwrap(); prop_assert_eq!(g.history(), &reference);
        g.close().unwrap(); let g = Graph::open(&f.0).unwrap(); prop_assert_eq!(g.history(), &reference);
    }
}
