//! Explicit ROS JointState / referenced-video adapters over the public graph API.
use arrow::record_batch::RecordBatch;
use chronograph_connector_common::{self as common, ArrowStore};
use chronograph_db::{EdgeId, EdgeInput, EdgeKind, Graph, NodeId};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};
pub mod cdr;
pub mod files;

const FORMAT: &str = "robotics-v1";
pub const MAX_MESSAGES: usize = 100_000;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid robotics input: {0}")]
    Invalid(String),
    #[error(transparent)]
    Graph(#[from] chronograph_db::Error),
    #[error(transparent)]
    Sidecar(#[from] common::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Mcap(#[from] mcap::McapError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mapping {
    pub robot_node: u64,
    pub clock_domain: String,
    pub fps: u32,
    pub topics: Vec<Topic>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Topic {
    pub name: String,
    pub node: u64,
    pub edge_kind: u16,
    pub message_type: String,
    pub role: Role,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Observation,
    Action,
    Video,
}
impl Mapping {
    pub fn from_toml(text: &str) -> Result<Self> {
        let value: Self = toml::from_str(text)?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        let mut names = HashSet::new();
        let mut keys = HashSet::new();
        if !(1..=1000).contains(&self.fps)
            || self.topics.is_empty()
            || self.topics.len() > 256
            || !matches!(self.clock_domain.as_str(), "unix_ns" | "simulation_ns")
        {
            return Err(Error::Invalid(
                "require 1–256 topics, 1–1000 fps and explicit unix_ns/simulation_ns clock".into(),
            ));
        }
        for t in &self.topics {
            if !t.name.starts_with('/')
                || t.name.len() > 256
                || t.node == self.robot_node
                || !names.insert(&t.name)
                || !keys.insert((t.node, t.edge_kind))
                || !matches!(
                    (t.message_type.as_str(), t.role),
                    (
                        "sensor_msgs/msg/JointState",
                        Role::Observation | Role::Action
                    ) | ("chronograph/VideoReference", Role::Video)
                )
            {
                return Err(Error::Invalid("topics need unique names/relationships and supported JointState or VideoReference roles".into()));
            }
        }
        Ok(())
    }
    pub fn topic(&self, name: &str) -> Option<&Topic> {
        self.topics.iter().find(|t| t.name == name)
    }
    fn metadata(&self) -> Result<String> {
        Ok(serde_json::to_string(self)?)
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stamp {
    pub sec: i32,
    pub nanosec: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub stamp: Stamp,
    pub frame_id: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JointState {
    pub header: Header,
    pub name: Vec<String>,
    pub position: Vec<f64>,
    pub velocity: Vec<f64>,
    pub effort: Vec<f64>,
}
impl JointState {
    pub fn validate(&self) -> Result<()> {
        let n = self.name.len();
        if n == 0
            || n > 4096
            || self.header.stamp.nanosec >= 1_000_000_000
            || self.header.frame_id.len() > 4096
            || self.name.iter().any(|s| s.is_empty() || s.len() > 256)
            || self.name.iter().collect::<HashSet<_>>().len() != n
            || [&self.position, &self.velocity, &self.effort]
                .iter()
                .any(|v| (!v.is_empty() && v.len() != n) || v.iter().any(|x| !x.is_finite()))
        {
            return Err(Error::Invalid(
                "malformed JointState: finite vectors must be empty or match unique joint names"
                    .into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoReference {
    /// Dataset-relative path; media remains outside the graph and is never fetched by the adapter.
    pub path: String,
    pub timestamp_ns: i64,
    pub sha256: String,
}
impl VideoReference {
    fn validate(&self) -> Result<()> {
        let p = Path::new(&self.path);
        if self.path.is_empty()
            || self.path.len() > 1024
            || self.path.contains(['\\', '\0', ':'])
            || p.is_absolute()
            || !p
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
            || self.timestamp_ns < 0
            || self.sha256.len() != 64
            || !self.sha256.bytes().all(|v| v.is_ascii_hexdigit())
        {
            return Err(Error::Invalid(
                "video reference needs a safe relative path, nonnegative media time and SHA-256"
                    .into(),
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Data {
    JointState(JointState),
    Video(VideoReference),
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub topic: String,
    /// Preserve original nanoseconds; graph time is floor(log_time_ns / 1000).
    pub log_time_ns: i64,
    pub publish_time_ns: i64,
    pub sequence: u32,
    pub data: Data,
}
impl Message {
    pub fn validate(&self, mapping: &Mapping) -> Result<()> {
        let topic = mapping
            .topic(&self.topic)
            .ok_or_else(|| Error::Invalid("unmapped topic".into()))?;
        if self.log_time_ns < 0 || self.publish_time_ns < 0 {
            return Err(Error::Invalid(
                "ROS/MCAP nanosecond times must fit nonnegative i64".into(),
            ));
        }
        match (&self.data, topic.message_type.as_str()) {
            (Data::JointState(v), "sensor_msgs/msg/JointState") => v.validate(),
            (Data::Video(v), "chronograph/VideoReference") => v.validate(),
            _ => Err(Error::Invalid(
                "payload does not match mapped ROS type".into(),
            )),
        }
    }
}
/// Entire normalized batch is validated before sidecars are synced and one atomic graph batch is appended.
pub fn ingest(
    graph: &mut Graph,
    store: &ArrowStore,
    mapping: &Mapping,
    messages: &[Message],
) -> Result<Vec<EdgeId>> {
    mapping.validate()?;
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err(Error::Invalid("require 1–100000 messages".into()));
    }
    for message in messages {
        message.validate(mapping)?;
    }
    let batch = common::records(FORMAT, &mapping.metadata()?, messages)?;
    let payloads = store.put(&batch)?;
    let edges: Vec<_> = messages
        .iter()
        .zip(payloads)
        .map(|(m, payload)| {
            let topic = mapping.topic(&m.topic).unwrap();
            EdgeInput {
                src: NodeId(mapping.robot_node),
                dst: NodeId(topic.node),
                kind: EdgeKind(topic.edge_kind),
                valid_from: m.log_time_ns / 1000,
                payload,
            }
        })
        .collect();
    Ok(graph.add_edges(&edges)?)
}

/// Export acquired messages in `[start_us,end_us)`, preserving exact nanoseconds and source fields.
pub fn export_messages(
    graph: &Graph,
    store: &ArrowStore,
    mapping: &Mapping,
    start_us: i64,
    end_us: i64,
) -> Result<Vec<Message>> {
    mapping.validate()?;
    if start_us >= end_us {
        return Err(Error::Invalid("empty/reversed export interval".into()));
    }
    let metadata = mapping.metadata()?;
    let mut cache = None;
    let mut result = Vec::new();
    for edge in graph.history().iter().filter(|e| {
        e.src.0 == mapping.robot_node
            && e.valid_from >= start_us
            && e.valid_from < end_us
            && mapping
                .topics
                .iter()
                .any(|t| t.node == e.dst.0 && t.edge_kind == e.kind.0)
    }) {
        if result.len() >= MAX_MESSAGES {
            return Err(Error::Invalid(
                "export exceeds 100000 messages; choose a smaller window".into(),
            ));
        }
        let key: [u8; 12] = edge.payload[..12].try_into().unwrap();
        if cache.as_ref().is_none_or(|(k, _)| k != &key) {
            cache = Some((key, store.read(edge.payload)?.0));
        }
        let row = u32::from_le_bytes(edge.payload[12..].try_into().unwrap()) as usize;
        let message: Message = common::decode(&cache.as_ref().unwrap().1, row, FORMAT, &metadata)?;
        message.validate(mapping)?;
        let topic = mapping.topic(&message.topic).unwrap();
        if message.log_time_ns / 1000 != edge.valid_from
            || topic.node != edge.dst.0
            || topic.edge_kind != edge.kind.0
        {
            return Err(Error::Invalid(
                "sidecar row and graph relationship disagree".into(),
            ));
        }
        result.push(message);
    }
    result.sort_by(|a, b| {
        (a.log_time_ns, &a.topic, a.sequence).cmp(&(b.log_time_ns, &b.topic, b.sequence))
    });
    Ok(result)
}
pub fn export_arrow(
    graph: &Graph,
    store: &ArrowStore,
    mapping: &Mapping,
    start: i64,
    end: i64,
) -> Result<RecordBatch> {
    Ok(common::records(
        FORMAT,
        &mapping.metadata()?,
        &export_messages(graph, store, mapping, start, end)?,
    )?)
}

/// Sample graph replay at a fixed episode grid. No future data is used for a frame.
/// LeRobot's official Python writer consumes this Arrow handoff (see scripts/connectors/).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrainingFrame {
    pub timestamp_us: i64,
    pub observation_time_ns: i64,
    pub action_time_ns: i64,
    pub observation: Vec<f64>,
    pub action: Vec<f64>,
    pub joint_names: Vec<String>,
    pub video: Vec<VideoReference>,
}
pub fn lerobot_frames(
    graph: &Graph,
    store: &ArrowStore,
    mapping: &Mapping,
    start_us: i64,
    count: usize,
    max_age_us: i64,
) -> Result<RecordBatch> {
    mapping.validate()?;
    if count == 0 || count > MAX_MESSAGES || start_us < 0 || max_age_us < 0 {
        return Err(Error::Invalid("invalid episode size/start/max_age".into()));
    }
    let roles = |role| mapping.topics.iter().filter(|t| t.role == role).count();
    if roles(Role::Observation) != 1 || roles(Role::Action) != 1 {
        return Err(Error::Invalid(
            "LeRobot export requires exactly one observation and action topic".into(),
        ));
    }
    let mut frames = Vec::with_capacity(count);
    let metadata = mapping.metadata()?;
    // Batch cache avoids reparsing an Arrow sidecar per temporal sample. At most four 16-MiB batches.
    let mut cache: HashMap<[u8; 12], RecordBatch> = HashMap::new();
    let mut joint_names: Option<Vec<String>> = None;
    for i in 0..count {
        let delta = (i as u64 * 1_000_000 / u64::from(mapping.fps)) as i64;
        let t = start_us
            .checked_add(delta)
            .ok_or_else(|| Error::Invalid("episode time overflow".into()))?;
        let mut state = None;
        let mut action = None;
        let mut video = Vec::new();
        for topic in &mapping.topics {
            let edge = graph
                .neighbors(NodeId(mapping.robot_node), t)
                .filter_map(|e| graph.edge(e.id))
                .find(|e| e.dst.0 == topic.node && e.kind.0 == topic.edge_kind);
            let Some(edge) = edge else {
                if topic.role == Role::Video {
                    continue;
                }
                return Err(Error::Invalid(format!("no {} sample at {t}", topic.name)));
            };
            if t.saturating_sub(edge.valid_from) > max_age_us {
                return Err(Error::Invalid(format!(
                    "stale {} sample at {t}",
                    topic.name
                )));
            }
            let key = edge.payload[..12].try_into().unwrap();
            if !cache.contains_key(&key) {
                if cache.len() == 4 {
                    cache.clear();
                }
                cache.insert(key, store.read(edge.payload)?.0);
            }
            let row = u32::from_le_bytes(edge.payload[12..].try_into().unwrap()) as usize;
            let m: Message = common::decode(&cache[&key], row, FORMAT, &metadata)?;
            m.validate(mapping)?;
            if m.topic != topic.name || m.log_time_ns / 1000 != edge.valid_from {
                return Err(Error::Invalid("graph/sidecar mismatch".into()));
            }
            // Microsecond graph time rounds down: reject a source nanosecond that is still in the future.
            if i128::from(m.log_time_ns) > i128::from(t) * 1000 {
                return Err(Error::Invalid("sample is later than the exact export grid; align start or use a coarser sample".into()));
            }
            match (m.data, topic.role) {
                (Data::JointState(j), role) => {
                    if j.position.is_empty() {
                        return Err(Error::Invalid("LeRobot needs JointState.position".into()));
                    }
                    if joint_names.as_ref().is_some_and(|n| n != &j.name) {
                        return Err(Error::Invalid(
                            "joint names/order changed across observation/action frames".into(),
                        ));
                    }
                    joint_names.get_or_insert(j.name);
                    if role == Role::Observation {
                        state = Some((j.position, m.log_time_ns));
                    } else {
                        action = Some((j.position, m.log_time_ns));
                    }
                }
                (Data::Video(v), Role::Video) => video.push(v),
                _ => return Err(Error::Invalid("topic role mismatch".into())),
            }
        }
        let (observation, observation_time_ns) = state.unwrap();
        let (action, action_time_ns) = action.unwrap();
        frames.push(TrainingFrame {
            timestamp_us: t,
            observation_time_ns,
            action_time_ns,
            observation,
            action,
            joint_names: joint_names.clone().unwrap(),
            video,
        });
    }
    Ok(common::records("lerobot-handoff-v1", &metadata, &frames)?)
}
