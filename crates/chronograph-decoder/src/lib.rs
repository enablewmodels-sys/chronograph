//! Portable decoder-v1 executor.
//!
//! A decoder trained anywhere writes model.json plus weights.bin; this crate reads that
//! artifact, verifies every tensor against its recorded SHA-256, reproduces the documented
//! feature extraction and linear layer in float64, and returns tokens with probabilities and an
//! explicit abstention state. It has no Python, BLAS or framework dependency, so it builds as a
//! static binary and runs where the training environment does not exist.
#![deny(missing_docs)]

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

/// Artifact failures. Every one is actionable and none is silently tolerated.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The artifact or input window is malformed, truncated or inconsistent.
    #[error("invalid decoder artifact: {0}")]
    Invalid(String),
    /// A tensor digest did not match the bytes on disk.
    #[error("decoder tensor {0} failed its checksum")]
    Checksum(String),
    /// Filesystem access failed.
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// The manifest is not valid JSON in the documented shape.
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Convenience result alias.
pub type Result<T> = std::result::Result<T, Error>;

/// The exact artifact format identifier this crate executes.
pub const FORMAT: &str = "decoder-v1";

#[derive(Debug, Clone, Deserialize)]
struct TensorSpec {
    name: String,
    dtype: String,
    shape: Vec<u64>,
    offset: u64,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AdapterInfo {
    name: String,
    version: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Manifest {
    format: String,
    adapter: AdapterInfo,
    kind: String,
    sample_rate_hz: f64,
    channels: Vec<String>,
    window_samples: u64,
    #[serde(default)]
    hop_samples: u64,
    bands_hz: Vec<f64>,
    #[serde(default)]
    log_features: bool,
    feature_dim: u64,
    slots: u64,
    #[serde(default)]
    vocabulary: Option<Vec<String>>,
    #[serde(default)]
    labels: Option<Vec<String>>,
    abstain_threshold: f64,
    #[serde(default)]
    normalize: bool,
    tensors: Vec<TensorSpec>,
    #[serde(default)]
    limits: BTreeMap<String, serde_json::Value>,
}

/// One decoded slot.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    /// Slot index within the window.
    pub slot: usize,
    /// Selected token, or None when the slot abstained.
    pub token: Option<String>,
    /// Winning probability after softmax.
    pub probability: f64,
    /// True when the winning probability stayed below the artifact threshold.
    pub abstained: bool,
}

/// One decoded window.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    /// Space-joined tokens; an abstained slot is the literal <abstain>.
    pub text: Option<String>,
    /// Selected class for a classification artifact.
    pub label: Option<String>,
    /// Mean slot probability.
    pub probability: f64,
    /// Per-slot detail.
    pub tokens: Vec<Token>,
    /// True when at least one slot abstained.
    pub abstained: bool,
}

/// A loaded and fully verified artifact.
pub struct Decoder {
    manifest: Manifest,
    tensors: BTreeMap<String, Tensor>,
}

struct Tensor {
    shape: Vec<usize>,
    values: Vec<f64>,
}

impl Tensor {
    fn at(&self, index: &[usize]) -> f64 {
        let mut flat = 0usize;
        for (axis, size) in index.iter().zip(&self.shape) {
            flat = flat * size + axis;
        }
        self.values.get(flat).copied().unwrap_or(f64::NAN)
    }
}

fn read_tensor(bytes: &[u8], spec: &TensorSpec) -> Result<Tensor> {
    let start = usize::try_from(spec.offset)
        .map_err(|_| Error::Invalid(format!("tensor {} offset overflow", spec.name)))?;
    let len = usize::try_from(spec.bytes)
        .map_err(|_| Error::Invalid(format!("tensor {} length overflow", spec.name)))?;
    let end = start
        .checked_add(len)
        .ok_or_else(|| Error::Invalid(format!("tensor {} range overflow", spec.name)))?;
    let slice = bytes
        .get(start..end)
        .ok_or_else(|| Error::Invalid(format!("tensor {} is truncated", spec.name)))?;
    let digest = format!("{:x}", Sha256::digest(slice));
    if !digest.eq_ignore_ascii_case(&spec.sha256) {
        return Err(Error::Checksum(spec.name.clone()));
    }
    let width = match spec.dtype.as_str() {
        "f32" => 4usize,
        "f64" => 8usize,
        other => {
            return Err(Error::Invalid(format!(
                "tensor {} has unsupported dtype {other}",
                spec.name
            )));
        }
    };
    if len % width != 0 {
        return Err(Error::Invalid(format!(
            "tensor {} is not aligned",
            spec.name
        )));
    }
    let count = len / width;
    let expected: usize = spec
        .shape
        .iter()
        .try_fold(1usize, |n, d| n.checked_mul(*d as usize))
        .ok_or_else(|| Error::Invalid(format!("tensor {} shape overflow", spec.name)))?;
    if expected != count {
        return Err(Error::Invalid(format!(
            "tensor {} declares {count} values but its shape needs {expected}",
            spec.name
        )));
    }
    let values = if width == 4 {
        slice
            .chunks_exact(4)
            .map(|c| f64::from(f32::from_le_bytes(c.try_into().unwrap())))
            .collect()
    } else {
        slice
            .chunks_exact(8)
            .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
            .collect()
    };
    Ok(Tensor {
        shape: spec.shape.iter().map(|d| *d as usize).collect(),
        values,
    })
}

impl Decoder {
    /// Load and fully verify an artifact directory containing model.json and weights.bin.
    pub fn open(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref();
        Self::from_bytes(
            &std::fs::read(directory.join("model.json"))?,
            &std::fs::read(directory.join("weights.bin"))?,
        )
    }

    /// Load and fully verify an artifact from bytes.
    ///
    /// This is the same reader the directory path uses, exposed for callers that have no
    /// filesystem at all: a WebAssembly module holds the manifest and weights in linear
    /// memory, and must not grow a second, weaker implementation of the format.
    pub fn from_bytes(model_json: &[u8], weights_bin: &[u8]) -> Result<Self> {
        let manifest: Manifest = serde_json::from_slice(model_json)?;
        if manifest.format != FORMAT {
            return Err(Error::Invalid(format!(
                "expected format {FORMAT}, found {}",
                manifest.format
            )));
        }
        if !matches!(manifest.kind.as_str(), "text" | "classification") {
            return Err(Error::Invalid(format!("unknown kind {}", manifest.kind)));
        }
        if !(manifest.abstain_threshold.is_finite()
            && (0.0..=1.0).contains(&manifest.abstain_threshold))
        {
            return Err(Error::Invalid(
                "abstain_threshold must be within 0-1".into(),
            ));
        }
        if manifest.channels.is_empty() || manifest.bands_hz.is_empty() || manifest.slots == 0 {
            return Err(Error::Invalid(
                "channels, bands_hz and slots must all be non-empty".into(),
            ));
        }
        if !(manifest.sample_rate_hz.is_finite() && manifest.sample_rate_hz > 0.0) {
            return Err(Error::Invalid("sample_rate_hz must be positive".into()));
        }
        let expected = manifest.channels.len() as u64 * manifest.bands_hz.len() as u64;
        if manifest.feature_dim != expected {
            return Err(Error::Invalid(format!(
                "feature_dim {} does not match {} channels x {} bands",
                manifest.feature_dim,
                manifest.channels.len(),
                manifest.bands_hz.len()
            )));
        }
        let classes = match manifest.kind.as_str() {
            "text" => manifest
                .vocabulary
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| Error::Invalid("a text artifact needs a vocabulary".into()))?
                .len(),
            _ => manifest
                .labels
                .as_ref()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| Error::Invalid("a classification artifact needs labels".into()))?
                .len(),
        };
        let mut tensors = BTreeMap::new();
        for spec in &manifest.tensors {
            if tensors.contains_key(&spec.name) {
                return Err(Error::Invalid(format!("duplicate tensor {}", spec.name)));
            }
            tensors.insert(spec.name.clone(), read_tensor(weights_bin, spec)?);
        }
        let shapes = [
            (
                "W",
                vec![
                    manifest.slots as usize,
                    manifest.feature_dim as usize,
                    classes,
                ],
            ),
            ("b", vec![manifest.slots as usize, classes]),
        ];
        for (name, shape) in shapes {
            let tensor = tensors
                .get(name)
                .ok_or_else(|| Error::Invalid(format!("missing tensor {name}")))?;
            if tensor.shape != shape {
                return Err(Error::Invalid(format!(
                    "tensor {name} has shape {:?}, expected {shape:?}",
                    tensor.shape
                )));
            }
        }
        if manifest.normalize {
            for name in ["feature_mean", "feature_std"] {
                let tensor = tensors
                    .get(name)
                    .ok_or_else(|| Error::Invalid(format!("normalize needs tensor {name}")))?;
                if tensor.shape != [manifest.feature_dim as usize] {
                    return Err(Error::Invalid(format!("tensor {name} has the wrong shape")));
                }
            }
        }
        Ok(Self { manifest, tensors })
    }

    /// Declared input geometry: channels, window samples and sample rate.
    pub fn geometry(&self) -> (usize, usize, f64) {
        (
            self.manifest.channels.len(),
            self.manifest.window_samples as usize,
            self.manifest.sample_rate_hz,
        )
    }

    /// Declared hop in samples, used by sliding-window callers.
    pub fn hop_samples(&self) -> usize {
        self.manifest.hop_samples as usize
    }

    /// Adapter name and version recorded in the artifact.
    pub fn adapter(&self) -> (&str, &str) {
        (&self.manifest.adapter.name, &self.manifest.adapter.version)
    }

    /// The artifact own limit statement, for honest reporting alongside results.
    pub fn limits(&self) -> &BTreeMap<String, serde_json::Value> {
        &self.manifest.limits
    }

    /// Channel names in the order the artifact expects.
    pub fn channels(&self) -> &[String] {
        &self.manifest.channels
    }

    /// Extract the documented features from one window of channels x window_samples.
    ///
    /// Hann window, single-frequency band power accumulated in float64 in channel-major,
    /// band-inner and sample-innermost order, then log1p when the artifact asks for it. The
    /// accumulation order is fixed so the Python and Rust tables agree; the trigonometric
    /// values themselves come from the platform libm, as they do in NumPy.
    pub fn features(&self, window: &[f64]) -> Result<Vec<f64>> {
        let channels = self.manifest.channels.len();
        let samples = self.manifest.window_samples as usize;
        if window.len() != channels * samples {
            return Err(Error::Invalid(format!(
                "window has {} values, expected {}",
                window.len(),
                channels * samples
            )));
        }
        if window.iter().any(|v| !v.is_finite()) {
            return Err(Error::Invalid(
                "window values must all be finite; gaps are never interpolated".into(),
            ));
        }
        let rate = self.manifest.sample_rate_hz;
        let taper: Vec<f64> = (0..samples)
            .map(|i| {
                if samples == 1 {
                    1.0
                } else {
                    0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / (samples - 1) as f64).cos()
                }
            })
            .collect();
        let mut out = Vec::with_capacity(channels * self.manifest.bands_hz.len());
        for channel in 0..channels {
            let row = &window[channel * samples..(channel + 1) * samples];
            for band in &self.manifest.bands_hz {
                let mut re = 0.0f64;
                let mut im = 0.0f64;
                for (i, value) in row.iter().enumerate() {
                    let angle = 2.0 * std::f64::consts::PI * band * i as f64 / rate;
                    let shaped = value * taper[i];
                    re += shaped * angle.cos();
                    im += shaped * angle.sin();
                }
                let power = re * re + im * im;
                out.push(if self.manifest.log_features {
                    power.ln_1p()
                } else {
                    power
                });
            }
        }
        if self.manifest.normalize {
            let mean = &self.tensors["feature_mean"];
            let std = &self.tensors["feature_std"];
            for (index, value) in out.iter_mut().enumerate() {
                let scale = std.values[index];
                *value = (*value - mean.values[index]) / if scale == 0.0 { 1.0 } else { scale };
            }
        }
        Ok(out)
    }

    /// Decode one already-extracted feature vector.
    pub fn decode_features(&self, features: &[f64]) -> Result<Decoded> {
        if features.len() != self.manifest.feature_dim as usize {
            return Err(Error::Invalid(format!(
                "features have {} values, expected {}",
                features.len(),
                self.manifest.feature_dim
            )));
        }
        let vocabulary: Vec<String> = match self.manifest.kind.as_str() {
            "text" => self.manifest.vocabulary.clone().unwrap_or_default(),
            _ => self.manifest.labels.clone().unwrap_or_default(),
        };
        let classes = vocabulary.len();
        let weight = &self.tensors["W"];
        let bias = &self.tensors["b"];
        let mut tokens = Vec::with_capacity(self.manifest.slots as usize);
        for slot in 0..self.manifest.slots as usize {
            let mut logits = Vec::with_capacity(classes);
            for class in 0..classes {
                let mut total = bias.at(&[slot, class]);
                for (index, value) in features.iter().enumerate() {
                    total += weight.at(&[slot, index, class]) * value;
                }
                logits.push(total);
            }
            let best = logits.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let mut total = 0.0f64;
            let mut probabilities = Vec::with_capacity(classes);
            for logit in &logits {
                let value = (logit - best).exp();
                probabilities.push(value);
                total += value;
            }
            let mut winner = 0usize;
            for (index, value) in probabilities.iter().enumerate() {
                if *value > probabilities[winner] {
                    winner = index;
                }
            }
            let probability = if total > 0.0 {
                probabilities[winner] / total
            } else {
                0.0
            };
            let abstained = probability < self.manifest.abstain_threshold;
            tokens.push(Token {
                slot,
                token: if abstained {
                    None
                } else {
                    Some(vocabulary[winner].clone())
                },
                probability,
                abstained,
            });
        }
        let abstained = tokens.iter().any(|t| t.abstained);
        let mean = tokens.iter().map(|t| t.probability).sum::<f64>() / tokens.len() as f64;
        let joined: Vec<String> = tokens
            .iter()
            .map(|t| t.token.clone().unwrap_or_else(|| "<abstain>".to_owned()))
            .collect();
        Ok(match self.manifest.kind.as_str() {
            "text" => Decoded {
                text: Some(joined.join(" ")),
                label: None,
                probability: mean,
                tokens,
                abstained,
            },
            _ => Decoded {
                text: None,
                label: tokens.first().and_then(|t| t.token.clone()),
                probability: mean,
                tokens,
                abstained,
            },
        })
    }

    /// Extract features and decode one window of channels x window_samples.
    pub fn decode(&self, window: &[f64]) -> Result<Decoded> {
        let features = self.features(window)?;
        self.decode_features(&features)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(directory: &Path) {
        // One channel, one band, one slot and two tokens: the smallest complete artifact.
        let weight = [1.0f32, -1.0];
        let bias = [0.25f32, -0.25];
        let mean = [0.0f32];
        let std = [1.0f32];
        let slices: Vec<&[f32]> = vec![&weight, &bias, &mean, &std];
        let mut weights = Vec::new();
        let mut offsets = Vec::new();
        let mut digests = Vec::new();
        for slice in &slices {
            offsets.push(weights.len() as u64);
            let mut bytes = Vec::new();
            for value in slice.iter() {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            digests.push(format!("{:x}", Sha256::digest(&bytes)));
            weights.extend_from_slice(&bytes);
        }
        let manifest = serde_json::json!({
            "format": FORMAT,
            "adapter": {"name": "fixture", "version": "1"},
            "kind": "text",
            "sample_rate_hz": 4.0,
            "channels": ["EEG01"],
            "window_samples": 4,
            "hop_samples": 4,
            "bands_hz": [1.0],
            "log_features": true,
            "feature_dim": 1,
            "slots": 1,
            "vocabulary": ["yes", "no"],
            "labels": null,
            "abstain_threshold": 0.0,
            "normalize": true,
            "tensors": [
                {"name":"W","dtype":"f32","shape":[1,1,2],"offset":offsets[0],"bytes":8,"sha256":digests[0]},
                {"name":"b","dtype":"f32","shape":[1,2],"offset":offsets[1],"bytes":8,"sha256":digests[1]},
                {"name":"feature_mean","dtype":"f32","shape":[1],"offset":offsets[2],"bytes":4,"sha256":digests[2]},
                {"name":"feature_std","dtype":"f32","shape":[1],"offset":offsets[3],"bytes":4,"sha256":digests[3]},
            ],
            "limits": {"vocabulary": "closed vocabulary only"},
        });
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(
            directory.join("model.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(directory.join("weights.bin"), &weights).unwrap();
    }

    fn directory(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("chronograph-decoder-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[test]
    fn features_decode_and_limits() {
        let dir = directory("ok");
        artifact(&dir);
        let decoder = Decoder::open(&dir).unwrap();
        assert_eq!(decoder.geometry(), (1, 4, 4.0));
        assert_eq!(decoder.hop_samples(), 4);
        assert_eq!(decoder.adapter(), ("fixture", "1"));
        assert_eq!(decoder.channels(), ["EEG01".to_string()]);
        assert!(decoder.limits().contains_key("vocabulary"));
        let features = decoder.features(&[1.0, 0.0, -1.0, 0.0]).unwrap();
        assert_eq!(features.len(), 1);
        assert!(features[0].is_finite() && features[0] >= 0.0);
        let decoded = decoder.decode(&[1.0, 0.0, -1.0, 0.0]).unwrap();
        assert!(!decoded.abstained);
        assert_eq!(decoded.tokens.len(), 1);
        // A band with real power wins clearly, and softmax stays a probability below one.
        assert!(decoded.tokens[0].probability > 0.75);
        assert_eq!(decoded.tokens[0].token.as_deref(), Some("yes"));
        assert!(!decoded.text.unwrap().contains(" "));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn abstention_and_malformed_artifacts_are_explicit() {
        let dir = directory("abstain");
        artifact(&dir);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("model.json")).unwrap()).unwrap();
        manifest["abstain_threshold"] = serde_json::json!(0.999_999);
        std::fs::write(
            dir.join("model.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        let decoder = Decoder::open(&dir).unwrap();
        let decoded = decoder.decode(&[1.0, 0.0, -1.0, 0.0]).unwrap();
        assert!(decoded.abstained);
        assert!(decoded.tokens[0].token.is_none());
        assert!(decoded.text.unwrap().contains("<abstain>"));
        // Wrong window length, a nonfinite sample and a stale feature count are all rejected.
        assert!(decoder.decode(&[1.0, 0.0]).is_err());
        assert!(decoder.features(&[f64::NAN, 0.0, 0.0, 0.0]).is_err());
        assert!(decoder.decode_features(&[1.0, 2.0]).is_err());
        // Truncation and a flipped byte are rejected instead of producing a number.
        let weights = std::fs::read(dir.join("weights.bin")).unwrap();
        std::fs::write(dir.join("weights.bin"), &weights[..weights.len() - 1]).unwrap();
        assert!(matches!(
            Decoder::open(&dir),
            Err(Error::Invalid(_)) | Err(Error::Checksum(_))
        ));
        std::fs::write(dir.join("weights.bin"), &weights).unwrap();
        let mut flipped = weights.clone();
        flipped[0] ^= 1;
        std::fs::write(dir.join("weights.bin"), &flipped).unwrap();
        assert!(matches!(Decoder::open(&dir), Err(Error::Checksum(_))));
        // A forged digest cannot hide the change, and the source file is never rewritten.
        std::fs::write(dir.join("weights.bin"), &weights).unwrap();
        manifest["tensors"][0]["sha256"] = serde_json::json!("0".repeat(64));
        std::fs::write(
            dir.join("model.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(Decoder::open(&dir), Err(Error::Checksum(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
