//! Versioned connector contracts shared by the service, migration writer and SDKs.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const VERSION: u32 = 1;
#[derive(Clone, Debug, Serialize)]
pub struct Definition {
    pub id: &'static str,
    pub family: &'static str,
    pub name: &'static str,
    pub presets: &'static [&'static str],
    pub contract_version: u32,
    pub transport: &'static str,
    pub native_import: &'static str,
    pub description: &'static str,
    pub upstream: &'static str,
}
macro_rules! definition {
    ($id:literal,$family:literal,$name:literal,[$($preset:literal),+],$native:literal,$description:literal,$url:literal) => {
        Definition { id:$id, family:$family, name:$name, presets:&[$($preset),+], contract_version:1, transport:"normalized_records_v1", native_import:$native, description:$description, upstream:$url }
    };
}
pub static DEFINITIONS: &[Definition] = &[
    definition!(
        "jev",
        "Decision models",
        "TypeSafe Jev",
        ["decisions-v1"],
        "python_typescript_adapter",
        "Store Jev Choice, Score and Noul decisions with probabilities, input fingerprints and model provenance. Inference runs in your producer using a separate TypeSafe API key.",
        "https://docs.typesafe.ai/api"
    ),
    definition!(
        "laya",
        "Decision models",
        "Convai Laya",
        ["decisions-v1"],
        "python_typescript_adapter",
        "Store locally produced Laya Choice, Score and Noul decisions, checkpoint and routing provenance. Run the Laya runtime in your own environment; no weights or inference run in the database.",
        "https://github.com/NandhaKishorM/laya"
    ),
    definition!(
        "jepa",
        "JEPA",
        "JEPA outputs",
        [
            "i-jepa",
            "v-jepa-1",
            "v-jepa-2",
            "v-jepa-2-ac",
            "v-jepa-2.1",
            "jepa-wms"
        ],
        "external_runtime",
        "Store output tensors, masks, actions and checkpoint provenance from your model process.",
        "https://github.com/facebookresearch/vjepa2"
    ),
    definition!(
        "hierarchical-jepa",
        "H-JEPA",
        "Hierarchical JEPA",
        ["hierarchical-v1"],
        "external_runtime",
        "Generic multi-level latent contract with parent IDs and prediction horizons; no upstream-specific architecture assumed.",
        ""
    ),
    definition!(
        "gymnasium",
        "World models",
        "Gymnasium",
        ["transition-v1"],
        "normalized_only",
        "Multimodal transitions, structured actions, rewards and independent terminated/truncated flags. Simulator restoration requires an external complete-state codec.",
        "https://gymnasium.farama.org/"
    ),
    definition!(
        "minari",
        "World models",
        "Minari",
        ["episode-v1"],
        "legacy_cli",
        "Episode transitions converted by the local producer. Existing CLI supports the documented Gridworld codec; generalized native conversion remains separate.",
        "https://minari.farama.org/main/content/dataset_standards/"
    ),
    definition!(
        "lsl",
        "BCI",
        "Lab Streaming Layer",
        ["signal-v1", "marker-v1", "gap-v1"],
        "legacy_rust",
        "Timestamped signal chunks, markers and explicit gaps. Existing Rust LSL float32 acquisition remains available separately.",
        "https://labstreaminglayer.readthedocs.io/"
    ),
    definition!(
        "mne",
        "BCI",
        "MNE recorded EEG",
        ["eeg-v1"],
        "python_mne_reader",
        "EEG tensors with channel names, units and source-clock timestamps, prepared by the local Python MNE reader.",
        "https://mne.tools/stable/auto_tutorials/io/20_reading_eeg_data.html"
    ),
    definition!(
        "lerobot",
        "Robotics",
        "LeRobot",
        ["v3-records", "v2.1-records"],
        "legacy_cli",
        "Normalized episode records with binary image/video assets. Existing v3 CLI exports joint vectors; native media dataset conversion is not provided by this endpoint.",
        "https://huggingface.co/docs/lerobot/lerobot-dataset-v3"
    ),
    definition!(
        "ros2",
        "Robotics",
        "ROS 2 / MCAP",
        [
            "joint-state",
            "image",
            "compressed-image",
            "imu",
            "odometry",
            "tf"
        ],
        "legacy_joint_state",
        "Normalized message records. Existing Rust bag reader handles JointState; other native message decoders require local conversion.",
        "https://docs.ros.org/en/rolling/p/rosbag2/"
    ),
    definition!(
        "openqasm",
        "Quantum",
        "OpenQASM",
        ["source-v1", "calibration-v1"],
        "legacy_static_subset",
        "Preserve circuit source as an opaque asset. The existing Rust parser supports its documented static unitary subset; uploading source never executes it.",
        "https://openqasm.com/"
    ),
    definition!(
        "qiskit",
        "Quantum",
        "Qiskit",
        ["circuit-v1", "result-v1"],
        "python_qiskit_adapter",
        "Circuit source and result provenance exported by your Qiskit process; no QPU connection or executable DAG is inferred.",
        "https://quantum.cloud.ibm.com/docs/en/api/qiskit/qasm3"
    ),
    definition!(
        "cirq",
        "Quantum",
        "Cirq",
        ["circuit-v1", "result-v1"],
        "python_cirq_adapter",
        "Circuit artifacts and measurement results exported by your Cirq process.",
        "https://quantumai.google/cirq"
    ),
    definition!(
        "brainflow",
        "BCI",
        "BrainFlow / OpenBCI",
        ["signal-v1"],
        "python_brainflow_adapter",
        "Locally acquired BrainFlow channel matrices with explicit units and board provenance. Synthetic board is tested; physical board support depends on your installed BrainFlow driver.",
        "https://brainflow.readthedocs.io/"
    ),
    definition!(
        "qsharp",
        "Quantum",
        "Q# / QDK",
        ["source-v1", "result-v1"],
        "python_qdk_host",
        "A Python host stores Q# source, QIR artifacts and local simulation results. The database never executes quantum programs or contacts a QPU.",
        "https://learn.microsoft.com/en-us/azure/quantum/"
    ),
    definition!(
        "quantum-results",
        "Quantum",
        "Portable quantum results",
        ["counts-v1", "observables-v1"],
        "normalized_only",
        "Counts or observables from caller-run PennyLane, Braket or other quantum runtimes, with explicit basis and execution provenance. No provider authentication or job execution.",
        ""
    ),
    definition!(
        "model-output",
        "World models",
        "Named model outputs",
        ["tensors-v1"],
        "python_tensor_adapter",
        "Named NumPy/PyTorch output tensors with model and checkpoint identifiers; usable for ONNX or other runtimes after local conversion. This does not load models.",
        ""
    ),
    definition!(
        "physical-ai",
        "Robotics",
        "Physical AI transitions",
        ["transition-v1"],
        "normalized_only",
        "Observation/action/reward transitions exported by caller-run robotics or simulation environments. Isaac, MuJoCo and other producers must supply their own complete-state codecs.",
        ""
    ),
    definition!(
        "custom",
        "Custom",
        "Custom records",
        ["record-v1"],
        "extension_sdk",
        "Versioned records, tensors, binary assets and temporal graph relationships.",
        ""
    ),
];
pub fn definition(id: &str) -> Option<&'static Definition> {
    DEFINITIONS.iter().find(|d| d.id == id)
}
pub fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 48
        && s.bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub id: String,
    pub connector: String,
    pub preset: String,
    pub contract_version: u32,
    pub kind: u16,
    pub clock_domain: String,
    #[serde(default)]
    pub modalities: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub units: Vec<String>,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub tensor_shapes: BTreeMap<String, Vec<u64>>,
    /// Names of secrets resolved only by an external producer; never secret values.
    #[serde(default)]
    pub secret_refs: Vec<String>,
}
impl Binding {
    pub fn validate(&self) -> Result<()> {
        let bad = |s: &str| Error::Invalid(s.into());
        let d = definition(&self.connector).ok_or_else(|| bad("unknown connector"))?;
        if !identifier(&self.id)
            || self.contract_version != VERSION
            || !d.presets.contains(&self.preset.as_str())
            || !["unix_us", "simulation_us", "lsl_local_us", "device_us"]
                .contains(&self.clock_domain.as_str())
        {
            return Err(bad(
                "invalid instance, contract version, preset or clock domain",
            ));
        }
        if self.modalities.len() > 32
            || self.channels.len() > 512
            || self.units.len() > 512
            || self.topics.len() > 64
            || self.tensor_shapes.len() > 32
            || self.secret_refs.len() > 16
        {
            return Err(bad("connector configuration exceeds resource limits"));
        }
        for values in [
            &self.modalities,
            &self.channels,
            &self.units,
            &self.topics,
            &self.secret_refs,
        ] {
            if values
                .iter()
                .any(|v| v.is_empty() || v.len() > 128 || v.chars().any(char::is_control))
            {
                return Err(bad("configuration labels require 1–128 printable bytes"));
            }
        }
        if !self.units.is_empty() && self.units.len() != self.channels.len() {
            return Err(bad("provide one unit for each channel"));
        }
        if self.tensor_shapes.iter().any(|(k, s)| {
            !identifier(k)
                || s.len() > 8
                || s.contains(&0)
                || s.iter()
                    .try_fold(1u64, |n, d| n.checked_mul(*d))
                    .is_none_or(|n| n > 16 * 1024 * 1024)
        }) {
            return Err(bad("invalid tensor shape"));
        }
        if self.secret_refs.iter().any(|v| !identifier(v)) {
            return Err(bad(
                "secret references must be environment variable names, never values",
            ));
        }
        Ok(())
    }
}
