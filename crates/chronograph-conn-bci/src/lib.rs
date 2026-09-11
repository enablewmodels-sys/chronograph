//! Neural stream adapters over the public Chronograph API. No medical decoding is performed.
use arrow::{
    array::{ArrayRef, Float32Array, Int64Array, UInt32Array, UInt64Array},
    datatypes::{DataType, Field, Schema},
    record_batch::RecordBatch,
};
use chronograph_db::{EdgeId, EdgeInput, EdgeKind, Graph, NodeId};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, sync::Arc};
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid BCI input: {0}")]
    Invalid(String),
    #[error(transparent)]
    Graph(#[from] chronograph_db::Error),
    #[error(transparent)]
    Arrow(#[from] arrow::error::ArrowError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid mapping: {0}")]
    Mapping(#[from] toml::de::Error),
    #[error("invalid metadata: {0}")]
    Metadata(#[from] serde_json::Error),
    #[cfg(feature = "lsl")]
    #[error("LSL transport: {0}")]
    Lsl(#[from] lsl::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub stream_node: u64,
    pub channel_base: u64,
    pub channels: u32,
    pub edge_kind: u16,
    pub sample_rate_hz: u32,
    pub unit: String,
    pub clock_domain: String,
    #[serde(default)]
    pub lsl_source_id: Option<String>,
}
impl Mapping {
    pub fn from_toml(text: &str) -> Result<Self> {
        let value: Self = toml::from_str(text)?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        let end = self.channel_base.checked_add(u64::from(self.channels));
        if !(1..=4096).contains(&self.channels)
            || self.sample_rate_hz == 0
            || self.sample_rate_hz > 1_000_000
            || end.is_none()
            || (self.channel_base..end.unwrap_or(0)).contains(&self.stream_node)
            || self.unit.is_empty()
            || self.unit.len() > 32
            || !matches!(
                self.clock_domain.as_str(),
                "simulation" | "lsl_local" | "unix_us"
            )
        {
            return Err(Error::Invalid("channels 1–4096, rate 1–1M Hz, separate stream/channel IDs, a unit, and an explicit clock domain are required".into()));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub sequence: u64,
    pub timestamp_us: i64,
    pub values: Vec<f32>,
}
/// Atomically ingest a batch of complete channel frames. The caller controls sync boundaries.
pub fn ingest(graph: &mut Graph, mapping: &Mapping, frames: &[Frame]) -> Result<Vec<EdgeId>> {
    mapping.validate()?;
    if frames.is_empty() || frames.len().saturating_mul(mapping.channels as usize) > 500_000 {
        return Err(Error::Invalid(
            "batch requires 1–500000 scalar channel observations".into(),
        ));
    }
    if frames.iter().any(|f| {
        f.values.len() != mapping.channels as usize
            || f.timestamp_us == i64::MAX
            || f.values.iter().any(|v| !v.is_finite())
    }) {
        return Err(Error::Invalid("each frame needs exactly the configured number of finite f32 channels and a timestamp below i64::MAX".into()));
    }
    let mut edges = Vec::with_capacity(frames.len() * mapping.channels as usize);
    for frame in frames {
        for (channel, value) in frame.values.iter().enumerate() {
            let mut payload = [0; 16];
            payload[..4].copy_from_slice(&value.to_le_bytes());
            payload[4..8].copy_from_slice(&(channel as u32).to_le_bytes());
            payload[8..].copy_from_slice(&frame.sequence.to_le_bytes());
            edges.push(EdgeInput {
                src: NodeId(mapping.channel_base + channel as u64),
                dst: NodeId(mapping.stream_node),
                kind: EdgeKind(mapping.edge_kind),
                valid_from: frame.timestamp_us,
                payload,
            });
        }
    }
    Ok(graph.add_edges(&edges)?)
}
/// Export acquired samples in `[start,end)`, retaining corrections/equal-time arrivals as separate rows.
pub fn export_epoch(graph: &Graph, mapping: &Mapping, start: i64, end: i64) -> Result<RecordBatch> {
    mapping.validate()?;
    if start >= end {
        return Err(Error::Invalid("epoch start must be below end".into()));
    }
    let mut rows = graph
        .history()
        .iter()
        .filter(|e| {
            e.kind.0 == mapping.edge_kind
                && e.dst.0 == mapping.stream_node
                && e.src.0 >= mapping.channel_base
                && e.src.0 < mapping.channel_base + u64::from(mapping.channels)
                && e.valid_from >= start
                && e.valid_from < end
        })
        .collect::<Vec<_>>();
    rows.sort_by_key(|e| {
        (
            e.valid_from,
            u64::from_le_bytes(e.payload[8..].try_into().unwrap()),
            e.src,
            e.id,
        )
    });
    for e in &rows {
        if u32::from_le_bytes(e.payload[4..8].try_into().unwrap())
            != (e.src.0 - mapping.channel_base) as u32
            || !f32::from_le_bytes(e.payload[..4].try_into().unwrap()).is_finite()
        {
            return Err(Error::Invalid(
                "graph relationship namespace contains a non-BCI payload".into(),
            ));
        }
    }
    let metadata = HashMap::from([
        ("chronograph.connector".into(), "bci-v1".into()),
        (
            "chronograph.mapping".into(),
            serde_json::to_string(mapping)?,
        ),
    ]);
    let schema = Arc::new(Schema::new_with_metadata(
        vec![
            Field::new("edge_id", DataType::UInt64, false),
            Field::new("sequence", DataType::UInt64, false),
            Field::new("timestamp_us", DataType::Int64, false),
            Field::new("channel", DataType::UInt32, false),
            Field::new("value", DataType::Float32, false),
        ],
        metadata,
    ));
    let arrays: Vec<ArrayRef> = vec![
        Arc::new(UInt64Array::from_iter_values(rows.iter().map(|e| e.id.0))),
        Arc::new(UInt64Array::from_iter_values(
            rows.iter()
                .map(|e| u64::from_le_bytes(e.payload[8..].try_into().unwrap())),
        )),
        Arc::new(Int64Array::from_iter_values(
            rows.iter().map(|e| e.valid_from),
        )),
        Arc::new(UInt32Array::from_iter_values(
            rows.iter().map(|e| (e.src.0 - mapping.channel_base) as u32),
        )),
        Arc::new(Float32Array::from_iter_values(
            rows.iter()
                .map(|e| f32::from_le_bytes(e.payload[..4].try_into().unwrap())),
        )),
    ];
    Ok(RecordBatch::try_new(schema, arrays)?)
}
/// Write an Arrow IPC epoch to a new file and synchronize it. Existing files are never replaced.
pub fn write_epoch(batch: &RecordBatch, path: impl AsRef<Path>) -> Result<()> {
    let path = path.as_ref();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    {
        let mut writer = arrow::ipc::writer::StreamWriter::try_new(&mut file, &batch.schema())?;
        writer.write(batch)?;
        writer.finish()?;
    }
    file.sync_all()?;
    std::fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}
/// Deterministic synthetic multi-channel waveform. It does not sleep or connect to hardware.
pub fn simulate(mapping: &Mapping, count: usize, start_us: i64) -> Result<Vec<Frame>> {
    mapping.validate()?;
    if mapping.clock_domain != "simulation"
        || count.saturating_mul(mapping.channels as usize) > 1_000_000
    {
        return Err(Error::Invalid(
            "simulator requires simulation clock and at most 1M scalar observations".into(),
        ));
    }
    (0..count)
        .map(|i| {
            let delta = (i as u128 * 1_000_000 / u128::from(mapping.sample_rate_hz))
                .try_into()
                .map_err(|_| Error::Invalid("timestamp overflow".into()))?;
            let t = start_us
                .checked_add(delta)
                .filter(|t| *t < i64::MAX)
                .ok_or_else(|| Error::Invalid("timestamp overflow".into()))?;
            let values = (0..mapping.channels)
                .map(|channel| {
                    let phase = i as f32 / mapping.sample_rate_hz as f32
                        * (8.0 + channel as f32)
                        * std::f32::consts::TAU;
                    phase.sin() * 25.0 + (channel as f32) * 0.125
                })
                .collect();
            Ok(Frame {
                sequence: i as u64,
                timestamp_us: t,
                values,
            })
        })
        .collect()
}
#[cfg(feature = "lsl")]
pub mod live {
    use super::*;
    use lsl::Pullable;
    pub struct Input {
        inlet: lsl::StreamInlet,
        mapping: Mapping,
        next_sequence: u64,
    }
    impl Input {
        pub fn connect(mapping: Mapping, timeout_seconds: f64) -> Result<Self> {
            mapping.validate()?;
            if mapping.clock_domain != "lsl_local"
                || !timeout_seconds.is_finite()
                || timeout_seconds <= 0.0
            {
                return Err(Error::Invalid(
                    "live input requires lsl_local clock and a finite positive timeout".into(),
                ));
            }
            let source = mapping
                .lsl_source_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| Error::Invalid("lsl_source_id is required".into()))?;
            let streams = lsl::resolve_byprop("source_id", source, 1, timeout_seconds)?;
            let info = streams.first().ok_or_else(|| {
                Error::Invalid("LSL source was not discovered before timeout".into())
            })?;
            if info.channel_count() != mapping.channels as i32
                || info.channel_format() != lsl::ChannelFormat::Float32
                || info.nominal_srate() != f64::from(mapping.sample_rate_hz)
            {
                return Err(Error::Invalid(
                    "LSL source must match the configured channel count, nominal rate and Float32 format".into(),
                ));
            }
            let inlet = lsl::StreamInlet::new(info, 60, 0, true)?;
            Ok(Self {
                inlet,
                mapping,
                next_sequence: 0,
            })
        }
        /// Read complete frames with a correction into the local LSL clock domain.
        pub fn read(&mut self, count: usize, timeout_seconds: f64) -> Result<Vec<Frame>> {
            if count == 0
                || count.saturating_mul(self.mapping.channels as usize) > 500_000
                || !timeout_seconds.is_finite()
                || timeout_seconds <= 0.0
            {
                return Err(Error::Invalid("invalid count or timeout".into()));
            }
            let correction = self.inlet.time_correction(timeout_seconds)?;
            let mut frames = Vec::with_capacity(count);
            for _ in 0..count {
                let (values, time): (Vec<f32>, f64) = self.inlet.pull_sample(timeout_seconds)?;
                let us = ((time + correction) * 1_000_000.0).round();
                if values.len() != self.mapping.channels as usize
                    || values.iter().any(|v| !v.is_finite())
                    || !us.is_finite()
                    || us < i64::MIN as f64
                    || us >= i64::MAX as f64
                {
                    return Err(Error::Invalid(
                        "LSL timeout, malformed sample or timestamp overflow".into(),
                    ));
                }
                let sequence = self.next_sequence;
                self.next_sequence = self
                    .next_sequence
                    .checked_add(1)
                    .ok_or_else(|| Error::Invalid("sequence exhausted".into()))?;
                frames.push(Frame {
                    sequence,
                    timestamp_us: us as i64,
                    values,
                });
            }
            Ok(frames)
        }
    }
}
