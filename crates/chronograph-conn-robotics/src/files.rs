//! Bounded, read-only file import. Unmapped topics are counted and skipped; mapped types must match.
use crate::{Data, Error, MAX_MESSAGES, Mapping, Message, Result, cdr};
use chronograph_connector_common::read_bounded;
use std::{collections::HashMap, path::Path};
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_MAPPED_BYTES: usize = 16 * 1024 * 1024;
#[derive(Debug)]
pub struct Import {
    pub messages: Vec<Message>,
    pub skipped: usize,
}
fn body(encoding: &str, typename: &str, bytes: &[u8]) -> Result<Data> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(Error::Invalid("message exceeds 1 MiB".into()));
    }
    match (encoding, typename) {
        ("cdr", "sensor_msgs/msg/JointState") => Ok(Data::JointState(cdr::joint_state(bytes)?)),
        ("json", "sensor_msgs/msg/JointState") => {
            Ok(Data::JointState(serde_json::from_slice(bytes)?))
        }
        ("json", "chronograph/VideoReference") => Ok(Data::Video(serde_json::from_slice(bytes)?)),
        _ => Err(Error::Invalid(format!(
            "unsupported {encoding} / {typename}; no inferred decoding"
        ))),
    }
}
pub fn rosbag2(path: impl AsRef<Path>, mapping: &Mapping) -> Result<Import> {
    mapping.validate()?;
    let path = path.as_ref();
    let meta = std::fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_FILE_BYTES as u64 {
        return Err(Error::Invalid(
            "rosbag2 database must be a regular .db3 file <=256 MiB".into(),
        ));
    }
    let db = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        (MAX_MESSAGE_BYTES + 8192) as i32,
    )?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN;")?;
    let mut topics = HashMap::new();
    let mut query = db.prepare("SELECT id, name, type, serialization_format FROM topics")?;
    let mut rows = query.query([])?;
    while let Some(row) = rows.next()? {
        if topics.len() >= 4096 {
            return Err(Error::Invalid("rosbag2 exceeds 4096 topics".into()));
        }
        let id: i64 = row.get(0)?;
        let name: String = row.get(1)?;
        let typ: String = row.get(2)?;
        let encoding: String = row.get(3)?;
        if let Some(topic) = mapping.topic(&name)
            && typ != topic.message_type
        {
            return Err(Error::Invalid(format!("ROS type mismatch for {name}")));
        }
        if topics.insert(id, (name, typ, encoding)).is_some() {
            return Err(Error::Invalid("duplicate rosbag2 topic ID".into()));
        }
    }
    let mut query =
        db.prepare("SELECT id, topic_id, timestamp, data FROM messages ORDER BY id LIMIT 1000001")?;
    let mut rows = query.query([])?;
    let mut result = Import {
        messages: Vec::new(),
        skipped: 0,
    };
    let mut total = 0;
    let mut mapped_bytes = 0usize;
    while let Some(row) = rows.next()? {
        total += 1;
        if total > 1_000_000 {
            return Err(Error::Invalid("rosbag2 exceeds 1M source records".into()));
        }
        let id: i64 = row.get(0)?;
        let topic_id: i64 = row.get(1)?;
        let t: i64 = row.get(2)?;
        let (name, typ, encoding) = topics
            .get(&topic_id)
            .ok_or_else(|| Error::Invalid("message references missing topic".into()))?;
        if mapping.topic(name).is_none() {
            result.skipped += 1;
            continue;
        }
        if result.messages.len() >= MAX_MESSAGES {
            return Err(Error::Invalid(
                "import exceeds 100000 mapped messages".into(),
            ));
        }
        let data: Vec<u8> = row.get(3)?;
        mapped_bytes = mapped_bytes.saturating_add(data.len());
        if mapped_bytes > MAX_MAPPED_BYTES {
            return Err(Error::Invalid(
                "mapped source payloads exceed 16 MiB; partition the recording".into(),
            ));
        }
        let m = Message {
            topic: name.clone(),
            log_time_ns: t,
            publish_time_ns: t,
            sequence: id
                .try_into()
                .map_err(|_| Error::Invalid("rosbag2 record ID must fit u32".into()))?,
            data: body(encoding, typ, &data)?,
        };
        m.validate(mapping)?;
        result.messages.push(m);
    }
    Ok(result)
}
pub fn mcap(path: impl AsRef<Path>, mapping: &Mapping) -> Result<Import> {
    mapping.validate()?;
    let bytes = read_bounded(path.as_ref(), MAX_FILE_BYTES)?;
    // Preflight chunk expansion before the high-level reader allocates decompression buffers.
    let mut expanded = 0u64;
    for record in mcap::read::LinearReader::new(&bytes)? {
        if let mcap::records::Record::Chunk { header, .. } = record? {
            if header.uncompressed_size > 64 * 1024 * 1024 {
                return Err(Error::Invalid("MCAP chunk expands beyond 64 MiB".into()));
            }
            expanded = expanded.saturating_add(header.uncompressed_size);
            if expanded > MAX_FILE_BYTES as u64 {
                return Err(Error::Invalid("MCAP expanded chunks exceed 256 MiB".into()));
            }
        }
    }
    let mut result = Import {
        messages: Vec::new(),
        skipped: 0,
    };
    let mut total = 0;
    let mut mapped_bytes = 0usize;
    for message in mcap::MessageStream::new(&bytes)? {
        total += 1;
        if total > 1_000_000 {
            return Err(Error::Invalid("MCAP exceeds 1M source records".into()));
        }
        let message = message?;
        let Some(topic) = mapping.topic(&message.channel.topic) else {
            result.skipped += 1;
            continue;
        };
        mapped_bytes = mapped_bytes.saturating_add(message.data.len());
        if mapped_bytes > MAX_MAPPED_BYTES {
            return Err(Error::Invalid(
                "mapped source payloads exceed 16 MiB; partition the recording".into(),
            ));
        }
        if result.messages.len() >= MAX_MESSAGES {
            return Err(Error::Invalid(
                "import exceeds 100000 mapped messages".into(),
            ));
        }
        let schema = message
            .channel
            .schema
            .as_ref()
            .ok_or_else(|| Error::Invalid("mapped MCAP channel lacks a schema".into()))?;
        if schema.name != topic.message_type
            || !matches!(
                (
                    message.channel.message_encoding.as_str(),
                    schema.encoding.as_str()
                ),
                ("cdr", "ros2msg") | ("json", "jsonschema")
            )
        {
            return Err(Error::Invalid(
                "mapped MCAP schema name/encoding does not match".into(),
            ));
        }
        let m = Message {
            topic: message.channel.topic.clone(),
            log_time_ns: message
                .log_time
                .try_into()
                .map_err(|_| Error::Invalid("MCAP timestamp exceeds i64".into()))?,
            publish_time_ns: message
                .publish_time
                .try_into()
                .map_err(|_| Error::Invalid("MCAP timestamp exceeds i64".into()))?,
            sequence: message.sequence,
            data: body(
                &message.channel.message_encoding,
                &topic.message_type,
                &message.data,
            )?,
        };
        m.validate(mapping)?;
        result.messages.push(m);
    }
    Ok(result)
}
