use std::{
    fs::{File, OpenOptions as FileOptions, TryLockError},
    io::{BufWriter, Write},
    path::Path,
};

use crate::{
    Durability, Edge, EdgeId, EdgeKind, Error, ForkId, GraphStats, NodeId, NodeRemap, OpenOptions,
    Result,
};

pub(crate) const MAGIC: &[u8; 8] = b"CHROGRPH";
pub(crate) const HEADER_LEN: usize = 12;
pub(crate) const MAX_FRAME: usize = 64 * 1024 * 1024;
pub(crate) const FORMAT_VERSION: u32 = 3;
const RECORD_VERSION: u16 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Insert {
    pub edge: Edge,
    pub predecessor: Option<EdgeId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergeData {
    pub fork: ForkId,
    pub nodes: Vec<NodeRemap>,
    pub inserts: Vec<Insert>,
    pub invalidations: Vec<(EdgeId, i64)>,
}

#[derive(Debug, Clone)]
pub(crate) enum Record {
    Node(NodeId),
    Insert(Insert),
    Invalidate(EdgeId, i64),
    Batch(Vec<Insert>),
    Ingest(crate::IngestReceipt, Vec<Insert>),
    ForkCreate {
        id: ForkId,
        parent_revision: u64,
        timestamp: i64,
        name: String,
    },
    ForkNode(ForkId, NodeId),
    ForkBatch(ForkId, Vec<Insert>),
    ForkInvalidate(ForkId, EdgeId, i64),
    ForkDiscard(ForkId),
    ForkMerge(MergeData),
}

pub(crate) struct Journal {
    writer: BufWriter<File>,
    scratch: Vec<u8>,
    options: OpenOptions,
    pub offset: u64,
    pub recovered_tail_bytes: u64,
    failed: bool,
    #[cfg(test)]
    pub fault_after: Option<usize>,
    #[cfg(test)]
    pub fault_sync: bool,
}

pub(crate) fn corrupt(offset: u64, reason: impl Into<String>) -> Error {
    Error::Corrupt {
        offset,
        reason: reason.into(),
    }
}

fn lock(file: &File) -> Result<()> {
    match file.try_lock() {
        Ok(()) => Ok(()),
        Err(TryLockError::WouldBlock) => Err(Error::Locked),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

fn header(version: u32) -> Vec<u8> {
    let mut bytes = MAGIC.to_vec();
    bytes.extend_from_slice(&version.to_le_bytes());
    bytes
}

/// Validate all complete frames, returning the last safe byte boundary.
/// A tail is repairable only when recovery is explicitly enabled.
fn replay_bytes(
    bytes: &[u8],
    version: u32,
    recover: bool,
    mut replay: impl FnMut(Record, u64) -> Result<()>,
) -> Result<usize> {
    let expected = header(version);
    if bytes.len() < HEADER_LEN {
        return if recover && expected.starts_with(bytes) {
            Ok(0)
        } else {
            Err(corrupt(0, "incomplete or invalid header"))
        };
    }
    if &bytes[..8] != MAGIC {
        return Err(corrupt(0, "invalid magic"));
    }
    let actual = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    if actual != version {
        return if actual < version && (1..=2).contains(&actual) {
            Err(Error::MigrationRequired)
        } else {
            Err(Error::UnsupportedFormat(format!("file version {actual}")))
        };
    }
    let mut offset = HEADER_LEN;
    while offset < bytes.len() {
        let remaining = bytes.len() - offset;
        if remaining < 8 {
            break;
        }
        let length = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let inverse = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap());
        if length as u32 != !inverse {
            return Err(corrupt(offset as u64, "record length integrity mismatch"));
        }
        if !(12..=MAX_FRAME).contains(&length) {
            return Err(corrupt(offset as u64, "invalid record length"));
        }
        if length > remaining - 8 {
            break;
        }
        let end = offset + 8 + length;
        let body = &bytes[offset + 8..end - 4];
        let checksum = u32::from_le_bytes(bytes[end - 4..end].try_into().unwrap());
        if crc32fast::hash(body) != checksum {
            if recover && end == bytes.len() {
                break;
            }
            return Err(corrupt(offset as u64, "record checksum mismatch"));
        }
        replay(
            decode_record(body, offset as u64, version as u16)?,
            offset as u64,
        )?;
        offset = end;
    }
    if !recover && offset != bytes.len() {
        return Err(corrupt(offset as u64, "incomplete migration source"));
    }
    Ok(offset)
}

impl Journal {
    pub fn open(
        path: &Path,
        options: OpenOptions,
        replay: impl FnMut(Record, u64) -> Result<()>,
    ) -> Result<Self> {
        let mut file = FileOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)?;
        lock(&file)?;
        let original_len = file.metadata()?.len();
        let mut valid_len = HEADER_LEN as u64;
        let mut recovered_tail_bytes = 0;
        if original_len > 0 {
            // SAFETY: this handle owns the advisory lock for the complete mapping lifetime.
            // We never write or truncate while mapped, expose no mapped references, and
            // require callers not to modify this file outside the locking protocol.
            let mmap = unsafe { memmap2::MmapOptions::new().map(&file)? };
            valid_len = replay_bytes(&mmap, FORMAT_VERSION, true, replay)? as u64;
            drop(mmap);
            if valid_len < original_len {
                recovered_tail_bytes = original_len - valid_len;
                file.set_len(valid_len)?;
                file.sync_all()?;
            }
        }
        if original_len == 0 || valid_len == 0 {
            file.write_all(&header(FORMAT_VERSION))?;
            file.sync_all()?;
            sync_parent(path)?;
            valid_len = HEADER_LEN as u64;
        }
        Ok(Self {
            writer: BufWriter::with_capacity(options.write_buffer_bytes, file),
            scratch: Vec::with_capacity(256),
            options,
            offset: valid_len,
            recovered_tail_bytes,
            failed: false,
            #[cfg(test)]
            fault_after: None,
            #[cfg(test)]
            fault_sync: false,
        })
    }

    pub fn ensure_writable(&self) -> Result<()> {
        if self.failed {
            Err(Error::WriterFailed)
        } else {
            Ok(())
        }
    }

    pub fn append(&mut self, record: &Record) -> Result<u64> {
        self.ensure_writable()?;
        encode_record(record, &mut self.scratch)?;
        let offset = self.offset;
        #[cfg(test)]
        if let Some(n) = self.fault_after.take() {
            self.writer
                .write_all(&self.scratch[..n.min(self.scratch.len())])?;
            self.writer.flush()?;
            self.failed = true;
            return Err(std::io::Error::other("injected partial append").into());
        }
        if let Err(error) = self.writer.write_all(&self.scratch) {
            self.failed = true;
            return Err(error.into());
        }
        if self.options.durability == Durability::Fsync {
            self.sync()?;
        }
        self.offset += self.scratch.len() as u64;
        Ok(offset)
    }

    pub fn sync(&mut self) -> Result<()> {
        self.ensure_writable()?;
        #[cfg(test)]
        if self.fault_sync {
            self.failed = true;
            self.writer.flush()?;
            return Err(std::io::Error::other("injected synchronization failure").into());
        }
        if let Err(error) = self
            .writer
            .flush()
            .and_then(|()| self.writer.get_ref().sync_all())
        {
            self.failed = true;
            return Err(error.into());
        }
        Ok(())
    }
}

impl Drop for Journal {
    fn drop(&mut self) {
        if !self.failed {
            let _ = self.sync();
        }
    }
}

fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}

/// Migrate a complete version-1 log without ever writing to its source.
/// The destination must not exist. Validation failure removes only our new file.
pub(crate) fn migrate_v1(source: &Path, destination: &Path) -> Result<GraphStats> {
    migrate(source, destination, 1)
}

pub(crate) fn migrate_v2(source: &Path, destination: &Path) -> Result<GraphStats> {
    migrate(source, destination, 2)
}

fn migrate(source: &Path, destination: &Path, version: u32) -> Result<GraphStats> {
    let input = File::open(source)?;
    lock(&input)?;
    if input.metadata()?.len() < HEADER_LEN as u64 {
        return Err(corrupt(0, "incomplete migration source"));
    }
    // SAFETY: the source remains exclusively locked and read-only until the mapping
    // is dropped. Destination writes use a distinct, newly created file.
    let map = unsafe { memmap2::MmapOptions::new().map(&input)? };
    let out = FileOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(destination)?;
    lock(&out)?;
    let mut writer = BufWriter::new(out);
    let result = (|| {
        writer.write_all(&header(FORMAT_VERSION))?;
        let mut index = crate::index::Index::default();
        let mut branches = crate::branch::BranchStore::default();
        let mut frame = Vec::new();
        let mut offset = HEADER_LEN as u64;
        replay_bytes(&map, version, false, |record, old_offset| {
            encode_record(&record, &mut frame)?;
            branches.replay(&mut index, record, old_offset)?;
            writer.write_all(&frame)?;
            offset += frame.len() as u64;
            Ok(())
        })?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        sync_parent(destination)?;
        Ok(GraphStats {
            nodes: index.nodes.len(),
            edge_versions: index.edges.len(),
            log_bytes: offset,
            recovered_tail_bytes: 0,
        })
    })();
    drop(writer);
    if result.is_err() {
        let _ = std::fs::remove_file(destination);
    }
    result
}

fn encode_insert(insert: &Insert, out: &mut Vec<u8>) {
    let e = insert.edge;
    out.extend_from_slice(&e.id.0.to_le_bytes());
    out.extend_from_slice(&e.src.0.to_le_bytes());
    out.extend_from_slice(&e.dst.0.to_le_bytes());
    out.extend_from_slice(&e.kind.0.to_le_bytes());
    out.extend_from_slice(&e.valid_from.to_le_bytes());
    out.extend_from_slice(&e.valid_to.to_le_bytes());
    out.extend_from_slice(&e.payload);
    out.push(u8::from(insert.predecessor.is_some()));
    if let Some(id) = insert.predecessor {
        out.extend_from_slice(&id.0.to_le_bytes());
    }
}

pub(crate) fn encode_record(record: &Record, output: &mut Vec<u8>) -> Result<()> {
    // Use u128 for preflight arithmetic, before allocating an oversized frame.
    let maximum = match record {
        Record::Ingest(receipt, items) => {
            128 + receipt.cursor.source.len() as u128
                + receipt.cursor.partition.len() as u128
                + items.len() as u128 * 67
        }
        Record::Batch(items) => 20 + items.len() as u128 * 67,
        Record::ForkBatch(_, items) => 28 + items.len() as u128 * 67,
        Record::ForkMerge(m) => {
            44 + m.nodes.len() as u128 * 16
                + m.inserts.len() as u128 * 67
                + m.invalidations.len() as u128 * 16
        }
        Record::ForkCreate { name, .. } => 40 + name.len() as u128,
        _ => 128,
    };
    if maximum > MAX_FRAME as u128 {
        return Err(Error::RecordTooLarge);
    }
    output.clear();
    output.extend_from_slice(&[0; 8]);
    output.extend_from_slice(&RECORD_VERSION.to_le_bytes());
    let tag: u16 = match record {
        Record::Node(_) => 1,
        Record::Insert(_) => 2,
        Record::Invalidate(_, _) => 3,
        Record::Batch(_) => 4,
        Record::ForkCreate { .. } => 5,
        Record::ForkNode(..) => 6,
        Record::ForkBatch(..) => 7,
        Record::ForkInvalidate(..) => 8,
        Record::ForkDiscard(..) => 9,
        Record::ForkMerge(..) => 10,
        Record::Ingest(..) => 11,
    };
    output.extend_from_slice(&tag.to_le_bytes());
    output.extend_from_slice(&0u32.to_le_bytes());
    match record {
        Record::Ingest(receipt, items) => {
            for value in [&receipt.cursor.source, &receipt.cursor.partition] {
                if value.len() > 96 {
                    return Err(Error::RecordTooLarge);
                }
                output.push(value.len() as u8);
                output.extend_from_slice(value.as_bytes());
            }
            output.extend_from_slice(&receipt.cursor.sequence.to_le_bytes());
            output.extend_from_slice(&receipt.cursor.digest);
            output.extend_from_slice(&receipt.first_edge.0.to_le_bytes());
            output.extend_from_slice(&receipt.edge_count.to_le_bytes());
            output.extend_from_slice(&receipt.revision.to_le_bytes());
            output.extend_from_slice(&(items.len() as u64).to_le_bytes());
            for item in items {
                encode_insert(item, output);
            }
        }
        Record::Node(id) => output.extend_from_slice(&id.0.to_le_bytes()),
        Record::Insert(insert) => encode_insert(insert, output),
        Record::Invalidate(id, t) => {
            output.extend_from_slice(&id.0.to_le_bytes());
            output.extend_from_slice(&t.to_le_bytes());
        }
        Record::Batch(items) => {
            output.extend_from_slice(&(items.len() as u64).to_le_bytes());
            for item in items {
                encode_insert(item, output);
            }
        }
        Record::ForkCreate {
            id,
            parent_revision,
            timestamp,
            name,
        } => {
            output.extend_from_slice(&id.0.to_le_bytes());
            output.extend_from_slice(&parent_revision.to_le_bytes());
            output.extend_from_slice(&timestamp.to_le_bytes());
            output.extend_from_slice(&(name.len() as u32).to_le_bytes());
            output.extend_from_slice(name.as_bytes());
        }
        Record::ForkNode(fork, id) => {
            output.extend_from_slice(&fork.0.to_le_bytes());
            output.extend_from_slice(&id.0.to_le_bytes());
        }
        Record::ForkBatch(fork, items) => {
            output.extend_from_slice(&fork.0.to_le_bytes());
            output.extend_from_slice(&(items.len() as u64).to_le_bytes());
            for item in items {
                encode_insert(item, output);
            }
        }
        Record::ForkInvalidate(fork, id, t) => {
            output.extend_from_slice(&fork.0.to_le_bytes());
            output.extend_from_slice(&id.0.to_le_bytes());
            output.extend_from_slice(&t.to_le_bytes());
        }
        Record::ForkDiscard(fork) => output.extend_from_slice(&fork.0.to_le_bytes()),
        Record::ForkMerge(m) => {
            output.extend_from_slice(&m.fork.0.to_le_bytes());
            output.extend_from_slice(&(m.nodes.len() as u64).to_le_bytes());
            for node in &m.nodes {
                output.extend_from_slice(&node.branch.0.to_le_bytes());
                output.extend_from_slice(&node.parent.0.to_le_bytes());
            }
            output.extend_from_slice(&(m.inserts.len() as u64).to_le_bytes());
            for item in &m.inserts {
                encode_insert(item, output);
            }
            output.extend_from_slice(&(m.invalidations.len() as u64).to_le_bytes());
            for (id, t) in &m.invalidations {
                output.extend_from_slice(&id.0.to_le_bytes());
                output.extend_from_slice(&t.to_le_bytes());
            }
        }
    }
    let checksum = crc32fast::hash(&output[8..]);
    output.extend_from_slice(&checksum.to_le_bytes());
    let length = output.len() - 8;
    if length > MAX_FRAME {
        return Err(Error::RecordTooLarge);
    }
    output[..4].copy_from_slice(&(length as u32).to_le_bytes());
    output[4..8].copy_from_slice(&(!(length as u32)).to_le_bytes());
    Ok(())
}

struct Decoder<'a> {
    bytes: &'a [u8],
    offset: u64,
}
impl Decoder<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        if self.bytes.len() < N {
            return Err(corrupt(self.offset, "truncated record field"));
        }
        let (field, rest) = self.bytes.split_at(N);
        self.bytes = rest;
        Ok(field.try_into().unwrap())
    }
    fn identifier(&mut self) -> Result<String> {
        let count = self.take::<1>()?[0] as usize;
        if count == 0 || count > 96 || count > self.bytes.len() {
            return Err(corrupt(self.offset, "invalid checkpoint identity"));
        }
        let value = std::str::from_utf8(&self.bytes[..count])
            .map_err(|_| corrupt(self.offset, "invalid identifier UTF-8"))?
            .to_owned();
        self.bytes = &self.bytes[count..];
        Ok(value)
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take()?))
    }
    fn count(&mut self, minimum: usize) -> Result<usize> {
        let count =
            usize::try_from(self.u64()?).map_err(|_| corrupt(self.offset, "count overflow"))?;
        if count > self.bytes.len() / minimum {
            return Err(corrupt(self.offset, "count exceeds record bounds"));
        }
        Ok(count)
    }
    fn inserts(&mut self) -> Result<Vec<Insert>> {
        let count = self.count(59)?;
        (0..count).map(|_| self.insert()).collect()
    }
    fn insert(&mut self) -> Result<Insert> {
        let edge = Edge {
            id: EdgeId(self.u64()?),
            src: NodeId(self.u64()?),
            dst: NodeId(self.u64()?),
            kind: EdgeKind(u16::from_le_bytes(self.take()?)),
            valid_from: i64::from_le_bytes(self.take()?),
            valid_to: i64::from_le_bytes(self.take()?),
            payload: self.take()?,
        };
        let predecessor = match self.take::<1>()?[0] {
            0 => None,
            1 => Some(EdgeId(self.u64()?)),
            _ => return Err(corrupt(self.offset, "invalid optional edge ID")),
        };
        Ok(Insert { edge, predecessor })
    }
}

fn decode_record(body: &[u8], offset: u64, expected_version: u16) -> Result<Record> {
    let mut reader = Decoder {
        bytes: body,
        offset,
    };
    let version = u16::from_le_bytes(reader.take()?);
    let tag = u16::from_le_bytes(reader.take()?);
    let flags = u32::from_le_bytes(reader.take()?);
    let maximum_tag = match expected_version {
        1 => 4,
        2 => 10,
        _ => 11,
    };
    if version != expected_version || flags != 0 || !(1..=maximum_tag).contains(&tag) {
        return Err(Error::UnsupportedFormat(format!(
            "record version={version}, tag={tag}, flags={flags}"
        )));
    }
    let result = match tag {
        1 => Record::Node(NodeId(reader.u64()?)),
        2 => Record::Insert(reader.insert()?),
        3 => Record::Invalidate(EdgeId(reader.u64()?), i64::from_le_bytes(reader.take()?)),
        4 => Record::Batch(reader.inserts()?),
        5 => {
            let id = ForkId(reader.u64()?);
            let parent_revision = reader.u64()?;
            let timestamp = i64::from_le_bytes(reader.take()?);
            let len = u32::from_le_bytes(reader.take()?) as usize;
            if len > 80 || len > reader.bytes.len() {
                return Err(corrupt(offset, "invalid fork name length"));
            }
            let name = std::str::from_utf8(&reader.bytes[..len])
                .map_err(|_| corrupt(offset, "invalid fork name UTF-8"))?
                .to_owned();
            reader.bytes = &reader.bytes[len..];
            Record::ForkCreate {
                id,
                parent_revision,
                timestamp,
                name,
            }
        }
        6 => Record::ForkNode(ForkId(reader.u64()?), NodeId(reader.u64()?)),
        7 => Record::ForkBatch(ForkId(reader.u64()?), reader.inserts()?),
        8 => Record::ForkInvalidate(
            ForkId(reader.u64()?),
            EdgeId(reader.u64()?),
            i64::from_le_bytes(reader.take()?),
        ),
        9 => Record::ForkDiscard(ForkId(reader.u64()?)),
        10 => {
            let fork = ForkId(reader.u64()?);
            let count = reader.count(16)?;
            let mut nodes = Vec::with_capacity(count);
            for _ in 0..count {
                nodes.push(NodeRemap {
                    branch: NodeId(reader.u64()?),
                    parent: NodeId(reader.u64()?),
                });
            }
            let inserts = reader.inserts()?;
            let count = reader.count(16)?;
            let mut invalidations = Vec::with_capacity(count);
            for _ in 0..count {
                invalidations.push((EdgeId(reader.u64()?), i64::from_le_bytes(reader.take()?)));
            }
            Record::ForkMerge(MergeData {
                fork,
                nodes,
                inserts,
                invalidations,
            })
        }
        11 => {
            let cursor = crate::IngestCursor {
                source: reader.identifier()?,
                partition: reader.identifier()?,
                sequence: reader.u64()?,
                digest: reader.take()?,
            };
            let receipt = crate::IngestReceipt {
                cursor,
                first_edge: EdgeId(reader.u64()?),
                edge_count: reader.u64()?,
                revision: reader.u64()?,
            };
            Record::Ingest(receipt, reader.inserts()?)
        }
        _ => unreachable!(),
    };
    if !reader.bytes.is_empty() {
        return Err(corrupt(offset, "unexpected bytes in record"));
    }
    Ok(result)
}
