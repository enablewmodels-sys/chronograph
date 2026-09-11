//! Immutable Arrow sidecars. Adapters use public graph APIs and store only a compact row reference inline.
pub mod assets;
pub mod registry;

use arrow::{
    array::{Array, StringArray},
    datatypes::{DataType, Field, Schema},
    record_batch::RecordBatch,
};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

pub const MAX_BATCH_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_ROWS: usize = 100_000;
const MAGIC: &[u8; 8] = b"CGAR0001";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid connector data: {0}")]
    Invalid(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Arrow(#[from] arrow::error::ArrowError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

/// Versioned typed records in a standard Arrow IPC-compatible batch.
pub fn records<T: Serialize>(connector: &str, mapping: &str, rows: &[T]) -> Result<RecordBatch> {
    if rows.len() > MAX_ROWS {
        return Err(Error::Invalid("too many rows".into()));
    }
    let mut values = Vec::with_capacity(rows.len());
    let mut bytes = 0usize;
    for row in rows {
        let s = serde_json::to_string(row)?;
        bytes = bytes.saturating_add(s.len());
        if bytes > MAX_BATCH_BYTES / 2 {
            return Err(Error::Invalid(
                "record batch exceeds 8 MiB of JSON data".into(),
            ));
        }
        values.push(s);
    }
    let schema = Arc::new(Schema::new_with_metadata(
        vec![Field::new("record_json", DataType::Utf8, false)],
        HashMap::from([
            ("chronograph.connector".into(), connector.into()),
            ("chronograph.mapping".into(), mapping.into()),
        ]),
    ));
    Ok(RecordBatch::try_new(
        schema,
        vec![Arc::new(StringArray::from(values))],
    )?)
}
pub fn decode<T: DeserializeOwned>(
    batch: &RecordBatch,
    row: usize,
    connector: &str,
    mapping: &str,
) -> Result<T> {
    if batch
        .schema()
        .metadata()
        .get("chronograph.connector")
        .map(String::as_str)
        != Some(connector)
        || batch
            .schema()
            .metadata()
            .get("chronograph.mapping")
            .map(String::as_str)
            != Some(mapping)
    {
        return Err(Error::Invalid("sidecar connector/mapping mismatch".into()));
    }
    let column = batch
        .column_by_name("record_json")
        .and_then(|a| a.as_any().downcast_ref::<StringArray>())
        .ok_or_else(|| Error::Invalid("missing record_json string column".into()))?;
    if row >= column.len() || column.is_null(row) {
        return Err(Error::Invalid("missing sidecar row".into()));
    }
    Ok(serde_json::from_str(column.value(row))?)
}

/// Payload bytes 0..12 are a SHA-256 prefix; 12..16 are a little-endian row offset.
/// A full 256-bit checksum is stored and verified in each sidecar's frame.
#[derive(Debug, Clone)]
pub struct ArrowStore {
    root: PathBuf,
}
fn ensure_directory(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Ok(());
    }
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => return Ok(()),
        Ok(_) => {
            return Err(Error::Invalid(
                "sidecar path must be a real directory".into(),
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    ensure_directory(parent)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
impl ArrowStore {
    /// Open/create a dedicated directory under the graph's `sidecars/` directory.
    /// The graph owner must exclusively control this local directory and its ancestors.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        ensure_directory(root)?;
        let meta = fs::symlink_metadata(root)?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(Error::Invalid(
                "sidecar root must be a real directory".into(),
            ));
        }
        Ok(Self {
            root: fs::canonicalize(root)?,
        })
    }
    fn path(&self, key: &[u8]) -> PathBuf {
        let name: String = key.iter().map(|v| format!("{v:02x}")).collect();
        self.root.join(format!("{name}.arrow"))
    }
    /// Synchronize a complete immutable batch before its references can enter the graph journal.
    pub fn put(&self, batch: &RecordBatch) -> Result<Vec<[u8; 16]>> {
        if batch.num_rows() == 0 || batch.num_rows() > MAX_ROWS {
            return Err(Error::Invalid("sidecar requires 1–100000 rows".into()));
        }
        let ipc = encode(batch)?;
        let digest = Sha256::digest(&ipc);
        let mut framed = Vec::with_capacity(ipc.len() + 40);
        framed.extend_from_slice(MAGIC);
        framed.extend_from_slice(&digest);
        framed.extend_from_slice(&ipc);
        let target = self.path(&digest[..12]);
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&framed)?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(&target) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if read_bounded(&target, MAX_BATCH_BYTES + 40)? != framed {
                    return Err(Error::Invalid(
                        "sidecar address collision or corrupt existing file; nothing overwritten"
                            .into(),
                    ));
                }
            }
            Err(e) => return Err(Error::Io(e.error)),
        }
        File::open(&self.root)?.sync_all()?;
        Ok((0..batch.num_rows())
            .map(|row| {
                let mut payload = [0; 16];
                payload[..12].copy_from_slice(&digest[..12]);
                payload[12..].copy_from_slice(&(row as u32).to_le_bytes());
                payload
            })
            .collect())
    }
    pub fn read(&self, payload: [u8; 16]) -> Result<(RecordBatch, usize)> {
        let bytes = read_bounded(&self.path(&payload[..12]), MAX_BATCH_BYTES + 40)?;
        if bytes.len() < 40 || &bytes[..8] != MAGIC {
            return Err(Error::Invalid("invalid sidecar header".into()));
        }
        let digest = Sha256::digest(&bytes[40..]);
        if digest.as_slice() != &bytes[8..40] || digest[..12] != payload[..12] {
            return Err(Error::Invalid("sidecar checksum/address mismatch".into()));
        }
        let mut reader =
            arrow::ipc::reader::StreamReader::try_new(std::io::Cursor::new(&bytes[40..]), None)?;
        let batch = reader
            .next()
            .ok_or_else(|| Error::Invalid("empty sidecar".into()))??;
        if reader.next().is_some() || batch.num_rows() > MAX_ROWS {
            return Err(Error::Invalid("invalid sidecar batch count".into()));
        }
        let row = u32::from_le_bytes(payload[12..].try_into().unwrap()) as usize;
        if row >= batch.num_rows() {
            return Err(Error::Invalid("sidecar row offset is out of bounds".into()));
        }
        Ok((batch, row))
    }
}

pub fn encode(batch: &RecordBatch) -> Result<Vec<u8>> {
    if batch.get_array_memory_size() > MAX_BATCH_BYTES {
        return Err(Error::Invalid("Arrow batch too large".into()));
    }
    let mut bytes = Vec::new();
    {
        let mut writer = arrow::ipc::writer::StreamWriter::try_new(&mut bytes, &batch.schema())?;
        writer.write(batch)?;
        writer.finish()?;
    }
    if bytes.len() > MAX_BATCH_BYTES {
        return Err(Error::Invalid("Arrow IPC batch too large".into()));
    }
    Ok(bytes)
}
pub fn write_ipc(batch: &RecordBatch, path: impl AsRef<Path>) -> Result<()> {
    let bytes = encode(batch)?;
    let path = path.as_ref();
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|e| Error::Io(e.error))?;
    File::open(parent)?.sync_all()?;
    Ok(())
}
pub fn read_bounded(path: &Path, max: usize) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > max as u64 {
        return Err(Error::Invalid(
            "input must be a bounded regular file, not a symlink".into(),
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(Error::Invalid("input grew beyond its size limit".into()));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_rows_integrity_collision_and_bounds() {
        let d = tempfile::tempdir().unwrap();
        let store = ArrowStore::open(d.path().join("sidecars")).unwrap();
        let batch = records("test-v1", "{}", &[vec![1.0, 2.0], vec![3.0, 4.0]]).unwrap();
        let refs = store.put(&batch).unwrap();
        assert_eq!(refs, store.put(&batch).unwrap());
        let (loaded, row) = store.read(refs[1]).unwrap();
        assert_eq!(
            decode::<Vec<f64>>(&loaded, row, "test-v1", "{}").unwrap(),
            vec![3.0, 4.0]
        );
        assert!(decode::<Vec<f64>>(&loaded, row, "other", "{}").is_err());
        let mut invalid = refs[0];
        invalid[12..].copy_from_slice(&2u32.to_le_bytes());
        assert!(store.read(invalid).is_err());
        let path = store.path(&refs[0][..12]);
        let mut bytes = fs::read(&path).unwrap();
        bytes[45] ^= 1;
        fs::write(&path, &bytes).unwrap();
        assert!(store.read(refs[0]).is_err());
        assert!(store.put(&batch).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}
