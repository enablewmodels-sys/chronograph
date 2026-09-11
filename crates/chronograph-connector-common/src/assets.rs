//! Bounded binary assets with exact tensor metadata and durable content addressing.
use crate::{Error, Result, ensure_directory, read_bounded};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

pub const MAX_ASSET_BYTES: usize = 16 * 1024 * 1024;
const MAX_META: usize = 16 * 1024;
const MAGIC: &[u8; 8] = b"CGAS0001";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dtype {
    U8,
    I8,
    U16,
    U32,
    U64,
    I16,
    I32,
    I64,
    F16,
    Bf16,
    F32,
    F64,
    Bool,
}
impl Dtype {
    pub fn bytes(&self) -> usize {
        match self {
            Self::U8 | Self::I8 | Self::Bool => 1,
            Self::U16 | Self::I16 | Self::F16 | Self::Bf16 => 2,
            Self::U32 | Self::I32 | Self::F32 => 4,
            Self::U64 | Self::I64 | Self::F64 => 8,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AssetMetadata {
    pub version: u32,
    /// `tensor`, `image`, `video`, `audio`, or `opaque`. No content is executed.
    pub kind: String,
    /// Tensor bytes are contiguous, row-major and little endian. Other assets retain their encoding.
    pub encoding: String,
    pub dtype: Option<Dtype>,
    #[serde(default)]
    pub shape: Vec<u64>,
    #[serde(default)]
    pub provenance: BTreeMap<String, String>,
}
impl AssetMetadata {
    pub fn validate(&self, bytes: &[u8]) -> Result<()> {
        let bad = |s: &str| Error::Invalid(s.into());
        if self.version != 1
            || bytes.is_empty()
            || bytes.len() > MAX_ASSET_BYTES
            || self.encoding.is_empty()
            || self.encoding.len() > 80
            || self.provenance.len() > 32
            || self
                .provenance
                .iter()
                .any(|(k, v)| k.is_empty() || k.len() > 80 || v.len() > 1024)
        {
            return Err(bad("invalid asset version, encoding, provenance or size"));
        }
        if self.kind == "tensor" {
            let dtype = self
                .dtype
                .as_ref()
                .ok_or_else(|| bad("tensor requires dtype"))?;
            if self.encoding != "raw_le" || self.shape.len() > 8 || self.shape.contains(&0) {
                return Err(bad(
                    "tensor requires raw_le encoding and ≤8 nonzero dimensions",
                ));
            }
            let count = self
                .shape
                .iter()
                .try_fold(dtype.bytes() as u64, |n, d| n.checked_mul(*d))
                .ok_or_else(|| bad("tensor shape overflow"))?;
            if count != bytes.len() as u64 {
                return Err(bad("tensor byte length does not match dtype and shape"));
            }
            if *dtype == Dtype::Bool && bytes.iter().any(|b| *b > 1) {
                return Err(bad("boolean tensor bytes must be 0 or 1"));
            }
        } else if !["image", "video", "audio", "opaque"].contains(&self.kind.as_str())
            || self.dtype.is_some()
            || !self.shape.is_empty()
        {
            return Err(bad(
                "non-tensor assets require a supported kind and no dtype or shape",
            ));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Asset {
    pub metadata: AssetMetadata,
    pub bytes: Vec<u8>,
    pub sha256: [u8; 32],
}
pub struct AssetStore {
    root: PathBuf,
}
impl AssetStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        ensure_directory(root.as_ref())?;
        Ok(Self {
            root: fs::canonicalize(root)?,
        })
    }
    fn path(&self, id: &[u8; 16]) -> PathBuf {
        self.root.join(format!(
            "{}.asset",
            id.iter().map(|v| format!("{v:02x}")).collect::<String>()
        ))
    }
    pub fn put(&self, metadata: &AssetMetadata, bytes: &[u8]) -> Result<[u8; 16]> {
        metadata.validate(bytes)?;
        let meta = serde_json::to_vec(metadata)?;
        if meta.len() > MAX_META {
            return Err(Error::Invalid("asset metadata exceeds 16 KiB".into()));
        }
        let mut body = Vec::with_capacity(4 + meta.len() + bytes.len());
        body.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        body.extend_from_slice(&meta);
        body.extend_from_slice(bytes);
        let digest = Sha256::digest(&body);
        let id: [u8; 16] = digest[..16].try_into().unwrap();
        let mut frame = Vec::with_capacity(40 + body.len());
        frame.extend_from_slice(MAGIC);
        frame.extend_from_slice(&digest);
        frame.extend_from_slice(&body);
        let mut temp = tempfile::NamedTempFile::new_in(&self.root)?;
        temp.write_all(&frame)?;
        temp.as_file().sync_all()?;
        match temp.persist_noclobber(self.path(&id)) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if read_bounded(&self.path(&id), MAX_ASSET_BYTES + MAX_META + 44)? != frame {
                    return Err(Error::Invalid(
                        "asset address collision or corruption; nothing overwritten".into(),
                    ));
                }
            }
            Err(e) => return Err(e.error.into()),
        }
        File::open(&self.root)?.sync_all()?;
        Ok(id)
    }
    pub fn get(&self, id: &[u8; 16]) -> Result<Asset> {
        let frame = read_bounded(&self.path(id), MAX_ASSET_BYTES + MAX_META + 44)?;
        if frame.len() < 44 || &frame[..8] != MAGIC {
            return Err(Error::Invalid("invalid asset frame".into()));
        }
        let digest: [u8; 32] = Sha256::digest(&frame[40..]).into();
        if digest != frame[8..40] || digest[..16] != *id {
            return Err(Error::Invalid("asset checksum mismatch".into()));
        }
        let size = u32::from_le_bytes(frame[40..44].try_into().unwrap()) as usize;
        if size > MAX_META || size > frame.len() - 44 {
            return Err(Error::Invalid("invalid metadata length".into()));
        }
        let metadata: AssetMetadata = serde_json::from_slice(&frame[44..44 + size])?;
        let bytes = frame[44 + size..].to_vec();
        metadata.validate(&bytes)?;
        Ok(Asset {
            metadata,
            bytes,
            sha256: digest,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_tensor_validation_and_checksum() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::open(dir.path()).unwrap();
        let meta = AssetMetadata {
            version: 1,
            kind: "tensor".into(),
            encoding: "raw_le".into(),
            dtype: Some(Dtype::F16),
            shape: vec![2, 2],
            provenance: BTreeMap::new(),
        };
        let bytes = [0, 0, 0, 60, 0, 124, 1, 126]; // Preserve even NaN/Inf bit patterns in model tensors.
        let id = store.put(&meta, &bytes).unwrap();
        assert_eq!(store.put(&meta, &bytes).unwrap(), id);
        let asset = store.get(&id).unwrap();
        assert_eq!(asset.metadata, meta);
        assert_eq!(asset.bytes, bytes);
        assert!(store.put(&meta, &bytes[..7]).is_err());
        let mut overflow = meta.clone();
        overflow.shape = vec![u64::MAX, 2];
        assert!(store.put(&overflow, &bytes).is_err());
        let path = store.path(&id);
        let mut frame = fs::read(&path).unwrap();
        *frame.last_mut().unwrap() ^= 1;
        fs::write(path, frame).unwrap();
        assert!(store.get(&id).is_err());
        assert!(store.put(&meta, &bytes).is_err());
    }
}
