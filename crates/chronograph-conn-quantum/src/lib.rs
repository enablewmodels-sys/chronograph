//! EXPLORATORY: a static circuit DAG and directed calibration windows, not a quantum simulator.
use arrow::record_batch::RecordBatch;
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::{BoundedEdgeInput, EdgeId, EdgeInput, EdgeKind, Graph, NodeId};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashSet};
pub mod parser;
const FORMAT: &str = "quantum-circuit-v1";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("exploratory quantum adapter: {0}")]
    Invalid(String),
    #[error(transparent)]
    Graph(#[from] chronograph_db::Error),
    #[error(transparent)]
    Sidecar(#[from] common::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub circuit_node: u64,
    pub device_node: u64,
    pub qubit_base: u64,
    pub operation_base: u64,
    pub manifest_kind: u16,
    pub contains_kind: u16,
    pub uses_kind: u16,
    pub acts_on_kind: u16,
    pub precedes_kind: u16,
    pub coupled_to_kind: u16,
    pub clock_domain: String,
}
impl Mapping {
    pub fn from_toml(text: &str) -> Result<Self> {
        let v: Self = toml::from_str(text)?;
        v.validate()?;
        Ok(v)
    }
    pub fn validate(&self) -> Result<()> {
        let qend = self.qubit_base.checked_add(64);
        let oend = self.operation_base.checked_add(4096);
        if qend.is_none()
            || oend.is_none()
            || self.circuit_node == self.device_node
            || !matches!(self.clock_domain.as_str(), "unix_us" | "simulation_us")
        {
            return Err(Error::Invalid("invalid node ranges or clock domain".into()));
        }
        let q = self.qubit_base..qend.unwrap();
        let o = self.operation_base..oend.unwrap();
        if (q.start < o.end && o.start < q.end)
            || [self.circuit_node, self.device_node]
                .iter()
                .any(|n| q.contains(n) || o.contains(n))
            || [
                self.manifest_kind,
                self.contains_kind,
                self.uses_kind,
                self.acts_on_kind,
                self.precedes_kind,
                self.coupled_to_kind,
            ]
            .into_iter()
            .collect::<HashSet<_>>()
            .len()
                != 6
        {
            return Err(Error::Invalid(
                "node ranges and relationship roles must be disjoint".into(),
            ));
        }
        Ok(())
    }
    fn metadata(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub gate: String,
    pub qubits: Vec<u32>,
    pub parameters: Vec<f64>,
    pub predecessors: Vec<u32>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Circuit {
    pub source: String,
    pub register: String,
    pub qubits: u32,
    pub operations: Vec<Operation>,
}
fn topology(map: &Mapping, circuit: &Circuit, t: i64, payload: [u8; 16]) -> Vec<EdgeInput> {
    let edge = |src, dst, kind| EdgeInput {
        src: NodeId(src),
        dst: NodeId(dst),
        kind: EdgeKind(kind),
        valid_from: t,
        payload,
    };
    let mut edges = vec![edge(map.circuit_node, map.device_node, map.manifest_kind)];
    for q in 0..circuit.qubits {
        edges.push(edge(
            map.circuit_node,
            map.qubit_base + u64::from(q),
            map.uses_kind,
        ));
    }
    for (i, op) in circuit.operations.iter().enumerate() {
        let node = map.operation_base + i as u64;
        edges.push(edge(map.circuit_node, node, map.contains_kind));
        for q in &op.qubits {
            edges.push(edge(node, map.qubit_base + u64::from(*q), map.acts_on_kind));
        }
        for previous in &op.predecessors {
            edges.push(edge(
                map.operation_base + u64::from(*previous),
                node,
                map.precedes_kind,
            ));
        }
    }
    edges
}
pub fn ingest_circuit(
    graph: &mut Graph,
    store: &ArrowStore,
    map: &Mapping,
    circuit: &Circuit,
    timestamp_us: i64,
) -> Result<Vec<EdgeId>> {
    map.validate()?;
    if timestamp_us == i64::MAX || parser::parse(&circuit.source)? != *circuit {
        return Err(Error::Invalid(
            "circuit must exactly match its parsed source and have a valid timestamp".into(),
        ));
    }
    if graph.contains_node(NodeId(map.circuit_node))
        || (0..circuit.operations.len())
            .any(|i| graph.contains_node(NodeId(map.operation_base + i as u64)))
    {
        return Err(Error::Invalid(
            "circuit/operation namespace already occupied; use a new mapping".into(),
        ));
    }
    let batch = common::records(FORMAT, &map.metadata()?, std::slice::from_ref(circuit))?;
    let payload = store.put(&batch)?[0];
    Ok(graph.add_edges(&topology(map, circuit, timestamp_us, payload))?)
}
pub fn export_circuit(graph: &Graph, store: &ArrowStore, map: &Mapping) -> Result<Circuit> {
    map.validate()?;
    let manifests: Vec<_> = graph
        .history()
        .iter()
        .filter(|e| {
            e.src.0 == map.circuit_node
                && e.dst.0 == map.device_node
                && e.kind.0 == map.manifest_kind
        })
        .collect();
    if manifests.len() != 1 {
        return Err(Error::Invalid(
            "expected exactly one circuit manifest".into(),
        ));
    }
    let manifest = manifests[0];
    let (batch, row) = store.read(manifest.payload)?;
    let circuit: Circuit = common::decode(&batch, row, FORMAT, &map.metadata()?)?;
    if parser::parse(&circuit.source)? != circuit {
        return Err(Error::Invalid("circuit source/AST mismatch".into()));
    }
    let expected = topology(map, &circuit, manifest.valid_from, manifest.payload);
    let expected_set: BTreeSet<_> = expected
        .iter()
        .map(|e| (e.src, e.dst, e.kind, e.valid_from, e.payload))
        .collect();
    let actual: Vec<_> = graph
        .history()
        .iter()
        .filter(|e| {
            e.src.0 == map.circuit_node
                || (map.operation_base..map.operation_base + 4096).contains(&e.src.0)
        })
        .collect();
    if actual.len() != expected.len()
        || actual.iter().any(|e| {
            e.valid_to != i64::MAX
                || !expected_set.contains(&(e.src, e.dst, e.kind, e.valid_from, e.payload))
        })
    {
        return Err(Error::Invalid(
            "graph topology no longer matches the static circuit DAG".into(),
        ));
    }
    Ok(circuit)
}
pub fn export_arrow(graph: &Graph, store: &ArrowStore, map: &Mapping) -> Result<RecordBatch> {
    Ok(common::records(
        FORMAT,
        &map.metadata()?,
        &[export_circuit(graph, store, map)?],
    )?)
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Calibration {
    pub from_qubit: u32,
    pub to_qubit: u32,
    pub valid_from: i64,
    pub valid_to: i64,
    /// Directed two-qubit operation error probability in `[0,1]`.
    pub error_rate: f64,
    /// Positive gate duration in nanoseconds, independent of the graph's microsecond clock.
    pub duration_ns: f64,
}
impl Calibration {
    fn validate(&self) -> Result<()> {
        if self.from_qubit >= 64
            || self.to_qubit >= 64
            || self.from_qubit == self.to_qubit
            || self.valid_from >= self.valid_to
            || !self.error_rate.is_finite()
            || !(0.0..=1.0).contains(&self.error_rate)
            || !self.duration_ns.is_finite()
            || self.duration_ns <= 0.0
        {
            return Err(Error::Invalid(
                "invalid directed calibration, validity window, error rate or duration".into(),
            ));
        }
        Ok(())
    }
}
/// Each calibration window is inserted with its end in the same atomic journal batch.
pub fn ingest_calibrations(
    graph: &mut Graph,
    map: &Mapping,
    windows: &[Calibration],
) -> Result<Vec<EdgeId>> {
    map.validate()?;
    if windows.is_empty() || windows.len() > 10_000 {
        return Err(Error::Invalid("require 1–10000 calibration windows".into()));
    }
    for window in windows {
        window.validate()?;
    }
    let inputs: Vec<_> = windows
        .iter()
        .map(|w| {
            let mut payload = [0; 16];
            payload[..8].copy_from_slice(&w.error_rate.to_le_bytes());
            payload[8..].copy_from_slice(&w.duration_ns.to_le_bytes());
            BoundedEdgeInput {
                edge: EdgeInput {
                    src: NodeId(map.qubit_base + u64::from(w.from_qubit)),
                    dst: NodeId(map.qubit_base + u64::from(w.to_qubit)),
                    kind: EdgeKind(map.coupled_to_kind),
                    valid_from: w.valid_from,
                    payload,
                },
                valid_to: w.valid_to,
            }
        })
        .collect();
    Ok(graph.add_edges_bounded(&inputs)?)
}
pub fn export_calibrations(graph: &Graph, map: &Mapping) -> Result<Vec<Calibration>> {
    map.validate()?;
    let range = map.qubit_base..map.qubit_base + 64;
    let mut result = Vec::new();
    for edge in graph.history().iter().filter(|e| {
        e.kind.0 == map.coupled_to_kind && range.contains(&e.src.0) && range.contains(&e.dst.0)
    }) {
        if result.len() >= 100_000 {
            return Err(Error::Invalid(
                "calibration export exceeds 100000 records".into(),
            ));
        }
        // Equal-time corrections can leave empty historical windows. Preserve them in this export.
        let window = Calibration {
            from_qubit: (edge.src.0 - map.qubit_base) as u32,
            to_qubit: (edge.dst.0 - map.qubit_base) as u32,
            valid_from: edge.valid_from,
            valid_to: edge.valid_to,
            error_rate: f64::from_le_bytes(edge.payload[..8].try_into().unwrap()),
            duration_ns: f64::from_le_bytes(edge.payload[8..].try_into().unwrap()),
        };
        if window.valid_to > window.valid_from {
            window.validate()?;
        } else if !window.error_rate.is_finite()
            || !(0.0..=1.0).contains(&window.error_rate)
            || !window.duration_ns.is_finite()
            || window.duration_ns <= 0.0
            || window.from_qubit == window.to_qubit
        {
            return Err(Error::Invalid(
                "invalid historical calibration payload".into(),
            ));
        }
        result.push(window);
    }
    Ok(result)
}
pub fn export_calibration_arrow(graph: &Graph, map: &Mapping) -> Result<RecordBatch> {
    Ok(common::records(
        "quantum-calibration-v1",
        &map.metadata()?,
        &export_calibrations(graph, map)?,
    )?)
}
