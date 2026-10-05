"""Portable decoder-v1 artifact: model.json plus weights.bin.

A Rust executor reads exactly this layout, so the bytes are fixed:

* An artifact is a directory holding model.json and weights.bin.
* model.json is UTF-8 JSON with the keys format ("decoder-v1"), adapter
  {name, version}, kind, sample_rate_hz, channels, window_samples,
  hop_samples, bands_hz, log_features, feature_dim, slots, vocabulary, labels,
  abstain_threshold, normalize, tensors, limits. bands_hz holds band CENTER
  frequencies. feature_dim == len(channels) * len(bands_hz). normalize == true
  means the feature_mean/feature_std tensors are applied before decoding.
* weights.bin holds every tensor concatenated, each starting at its own byte
  offset, little-endian, C order (row-major). A tensor record is
  {name, dtype, shape, offset, bytes, sha256} with dtype in f32|f64|i64 and
  sha256 the hex digest of that tensor's exact byte slice.
* Files written here place tensors back to back with no padding. Readers must
  use the recorded offsets and accept gaps, but overlapping, duplicated or
  out-of-bounds ranges are rejected.
* Named tensors: W [slots, feature_dim, vocab], b [slots, vocab], and, when
  normalize is true, feature_mean and feature_std [feature_dim]. Floats are
  stored as f32 by default (f64 on request).
* The adapter-level canonical hash is sha256 over the W byte slice followed by
  the b byte slice, in that order, in the stored dtype; see
  canonical_weights_sha256.

Decoding arithmetic is float64 throughout and is identical to the in-memory
path, so a Python predict and an artifact run agree to the last bit here (the
test compares them with a 1e-9 tolerance).
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path

import numpy as np

from .base import KINDS, AdapterError, DecoderManifest
from .features import band_features, band_list
from .features import feature_dim as _feature_dim

FORMAT = "decoder-v1"
MODEL_NAME = "model.json"
WEIGHTS_NAME = "weights.bin"
DTYPES = {"f32": np.dtype("<f4"), "f64": np.dtype("<f8"), "i64": np.dtype("<i8")}
DTYPE_NAMES = {"<f4": "f32", "<f8": "f64", "<i8": "i64"}
TENSOR_ORDER = ("W", "b", "feature_mean", "feature_std")
REQUIRED_DOCUMENT_KEYS = (
    "format",
    "adapter",
    "kind",
    "sample_rate_hz",
    "channels",
    "window_samples",
    "hop_samples",
    "bands_hz",
    "log_features",
    "feature_dim",
    "slots",
    "vocabulary",
    "labels",
    "abstain_threshold",
    "normalize",
    "tensors",
    "limits",
)
MAX_MODEL_BYTES = 256 * 1024
MAX_WEIGHTS_BYTES = 64 * 1024 * 1024
MAX_FEATURE_DIM = 4096
MAX_SLOTS = 64
MAX_VOCABULARY = 4096
MAX_CHANNELS = 512


def _document_value(document, key, what):
    if key not in document:
        raise AdapterError(f"model.json is missing {what} ({key})")
    return document[key]


def _check_document(document):
    """Validate every non-tensor document field and return the checked copy."""
    if not isinstance(document, dict):
        raise AdapterError("model.json must hold a JSON object")
    missing = [key for key in REQUIRED_DOCUMENT_KEYS if key not in document]
    if missing:
        raise AdapterError(f"model.json is missing {missing}")
    if document["format"] != FORMAT:
        raise AdapterError(
            f"unsupported artifact format {document['format']!r}; expected {FORMAT!r}"
        )
    adapter = document["adapter"]
    if (
        not isinstance(adapter, dict)
        or not isinstance(adapter.get("name"), str)
        or not adapter["name"]
        or len(adapter["name"]) > 256
        or not isinstance(adapter.get("version"), str)
        or not adapter["version"]
        or len(adapter["version"]) > 256
    ):
        raise AdapterError("model.json adapter requires nonempty name and version strings")
    if document["kind"] not in KINDS:
        raise AdapterError(f"kind must be one of {KINDS}, received {document['kind']!r}")
    rate = document["sample_rate_hz"]
    if isinstance(rate, bool) or not isinstance(rate, (int, float)):
        raise AdapterError("sample_rate_hz must be a number")
    rate = float(rate)
    if not math.isfinite(rate) or rate <= 0 or rate > 100_000:
        raise AdapterError("sample_rate_hz must be finite, positive and at most 100000 Hz")
    channels = document["channels"]
    if not isinstance(channels, list) or len(channels) > MAX_CHANNELS:
        raise AdapterError(f"channels must be a list of at most {MAX_CHANNELS} names")
    if any(not isinstance(c, str) or not c or len(c) > 256 for c in channels):
        raise AdapterError("channels must hold nonempty strings")
    if len(set(channels)) != len(channels):
        raise AdapterError("channels must not repeat a name")
    for key in ("window_samples", "hop_samples"):
        value = document[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise AdapterError(f"{key} must be a positive integer")
    if document["window_samples"] > 1 << 24 or document["hop_samples"] > 1 << 24:
        raise AdapterError("window_samples and hop_samples must stay below 16777216")
    bands = band_list(document["bands_hz"], rate)
    for key in ("log_features", "normalize"):
        if not isinstance(document[key], bool):
            raise AdapterError(f"{key} must be a bool")
    dim = document["feature_dim"]
    if isinstance(dim, bool) or not isinstance(dim, int) or not 1 <= dim <= MAX_FEATURE_DIM:
        raise AdapterError(f"feature_dim must be an integer in 1..{MAX_FEATURE_DIM}")
    if channels and dim != _feature_dim(len(channels), bands):
        raise AdapterError(
            f"feature_dim {dim} disagrees with {len(channels)} channels x "
            f"{len(bands)} bands = {len(channels) * len(bands)}"
        )
    slots = document["slots"]
    if isinstance(slots, bool) or not isinstance(slots, int) or not 1 <= slots <= MAX_SLOTS:
        raise AdapterError(f"slots must be an integer in 1..{MAX_SLOTS}")
    for key in ("vocabulary", "labels"):
        value = document[key]
        if value is None:
            continue
        if (
            not isinstance(value, list)
            or not 2 <= len(value) <= MAX_VOCABULARY
            or any(not isinstance(v, str) or not v or len(v) > 256 for v in value)
            or len(set(value)) != len(value)
        ):
            raise AdapterError(
                f"{key} must be null or a list of 2..{MAX_VOCABULARY} unique nonempty strings"
            )
    if document["vocabulary"] is None and document["labels"] is None:
        raise AdapterError(
            "model.json needs vocabulary (text) or labels (classification) to name outputs"
        )
    threshold = document["abstain_threshold"]
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise AdapterError("abstain_threshold must be a number")
    threshold = float(threshold)
    if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
        raise AdapterError("abstain_threshold must be between 0 and 1")
    if not isinstance(document["limits"], dict) or any(
        not isinstance(k, str) for k in document["limits"]
    ):
        raise AdapterError("limits must be a JSON object with string keys")
    checked = {key: document[key] for key in REQUIRED_DOCUMENT_KEYS}
    checked["sample_rate_hz"] = rate
    checked["bands_hz"] = list(bands)
    checked["channels"] = list(channels)
    checked["abstain_threshold"] = threshold
    return checked


def output_names(document):
    """Token or class names of an artifact: vocabulary first, then labels."""
    names = document["vocabulary"] if document["vocabulary"] is not None else document["labels"]
    return list(names)


def expected_shapes(document):
    """Shape of every tensor the document requires."""
    width = len(output_names(document))
    shapes = {
        "W": (document["slots"], document["feature_dim"], width),
        "b": (document["slots"], width),
    }
    if document["normalize"]:
        shapes["feature_mean"] = (document["feature_dim"],)
        shapes["feature_std"] = (document["feature_dim"],)
    return shapes


def _json_bytes(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def _atomic_write(path: Path, payload: bytes) -> None:
    """Write inside path.parent only: temp file in the same directory, then rename."""
    handle, temporary = tempfile.mkstemp(
        dir=str(path.parent), prefix="." + path.name + ".", suffix=".tmp"
    )
    try:
        with os.fdopen(handle, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def save_artifact(directory, manifest_dict, tensors, *, precision="f32"):
    """Write model.json and weights.bin atomically and return the directory path.

    tensors must supply W and b, plus feature_mean and feature_std when
    normalize is true. Everything is written inside the given directory only.
    """
    if precision not in ("f32", "f64"):
        raise AdapterError("precision must be 'f32' or 'f64'")
    float_dtype = DTYPES[precision]
    document = _check_document(manifest_dict)
    if not isinstance(tensors, dict):
        raise AdapterError("tensors must be a dict of numpy arrays")
    unknown = sorted(set(tensors) - set(TENSOR_ORDER))
    if unknown:
        raise AdapterError(
            f"unsupported tensors {unknown}; the decoder-v1 format defines {list(TENSOR_ORDER)}"
        )
    shapes = expected_shapes(document)
    arrays = {}
    for name, shape in shapes.items():
        if name not in tensors:
            raise AdapterError(f"missing tensor {name} with shape {list(shape)}")
        array = np.asarray(tensors[name])
        if array.dtype.kind != "f" or array.dtype.itemsize not in (4, 8):
            raise AdapterError(f"tensor {name} must be a float32 or float64 array")
        values = np.ascontiguousarray(array, dtype=float_dtype)
        if tuple(values.shape) != shape:
            raise AdapterError(
                f"tensor {name} must have shape {list(shape)}, received {list(values.shape)}"
            )
        if not np.isfinite(values).all():
            raise AdapterError(f"tensor {name} contains nonfinite values")
        if name == "feature_std" and not (values > 0).all():
            raise AdapterError("feature_std must be strictly positive")
        arrays[name] = values
    records = []
    chunks = []
    offset = 0
    for name in TENSOR_ORDER:
        if name not in arrays:
            continue
        payload = arrays[name].tobytes(order="C")
        records.append(
            {
                "name": name,
                "dtype": DTYPE_NAMES[float_dtype.str],
                "shape": [int(v) for v in arrays[name].shape],
                "offset": offset,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        )
        chunks.append(payload)
        offset += len(payload)
    if offset > MAX_WEIGHTS_BYTES:
        raise AdapterError(
            f"weights.bin would be {offset} bytes, above the bound of {MAX_WEIGHTS_BYTES}"
        )
    document = dict(document)
    document["tensors"] = records
    payload = _json_bytes(document)
    if len(payload) > MAX_MODEL_BYTES:
        raise AdapterError(f"model.json would be {len(payload)} bytes, above the bound")
    root = Path(directory)
    if root.exists() and not root.is_dir():
        raise AdapterError(f"{root} exists and is not a directory")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    _atomic_write(root / WEIGHTS_NAME, b"".join(chunks))
    _atomic_write(root / MODEL_NAME, payload)
    return str(root)


def load_artifact(directory):
    """Verify and load an artifact as (document, tensors).

    Raises AdapterError on a wrong format, a duplicated or overlapping range, a
    truncated file, or any sha256 mismatch.
    """
    root = Path(directory)
    model_path = root / MODEL_NAME
    weights_path = root / WEIGHTS_NAME
    for path, limit in ((model_path, MAX_MODEL_BYTES), (weights_path, MAX_WEIGHTS_BYTES)):
        if path.is_symlink() or not path.is_file():
            raise AdapterError(f"artifact is missing the regular file {path.name} in {root}")
        size = path.stat().st_size
        if size > limit:
            raise AdapterError(f"{path.name} is {size} bytes, above the bound of {limit}")
    try:
        document = json.loads(model_path.read_bytes())
    except (ValueError, UnicodeDecodeError) as error:
        raise AdapterError(f"model.json is not valid UTF-8 JSON: {error}") from None
    if not isinstance(document, dict):
        raise AdapterError("model.json must hold a JSON object")
    checked = _check_document(document)
    raw = weights_path.read_bytes()
    records = document.get("tensors")
    if not isinstance(records, list) or not 1 <= len(records) <= len(TENSOR_ORDER):
        raise AdapterError(
            f"model.json tensors must be a list of 1..{len(TENSOR_ORDER)} records"
        )
    shapes = expected_shapes(checked)
    arrays = {}
    used = []
    for record in records:
        if not isinstance(record, dict):
            raise AdapterError("every tensor record must be a JSON object")
        name = record.get("name")
        if name not in shapes:
            raise AdapterError(
                f"unexpected tensor {name!r}; expected {sorted(shapes)}"
            )
        if name in arrays:
            raise AdapterError(f"tensor {name} is declared twice in model.json")
        dtype_name = record.get("dtype")
        if dtype_name not in DTYPES:
            raise AdapterError(f"tensor {name} has unsupported dtype {dtype_name!r}")
        dtype = DTYPES[dtype_name]
        if dtype.kind != "f":
            raise AdapterError(f"tensor {name} must use a float dtype, received {dtype_name}")
        shape = record.get("shape")
        if (
            not isinstance(shape, list)
            or any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in shape)
        ):
            raise AdapterError(f"tensor {name} needs a list of nonnegative integer dimensions")
        if tuple(shape) != shapes[name]:
            raise AdapterError(
                f"tensor {name} must have shape {list(shapes[name])}, received {shape}"
            )
        size = record.get("bytes")
        offset = record.get("offset")
        if isinstance(size, bool) or not isinstance(size, int) or size < 0:
            raise AdapterError(f"tensor {name} needs a nonnegative byte length")
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise AdapterError(f"tensor {name} needs a nonnegative byte offset")
        needed = dtype.itemsize
        for value in shape:
            needed *= value
        if needed != size:
            raise AdapterError(
                f"tensor {name} declares {size} bytes but its shape needs {needed}"
            )
        if offset + size > len(raw):
            raise AdapterError(
                f"tensor {name} spans bytes {offset}..{offset + size} beyond the "
                f"{len(raw)}-byte weights.bin; the artifact is truncated"
            )
        for start, stop, other in used:
            if offset < stop and start < offset + size:
                raise AdapterError(f"tensor {name} overlaps tensor {other} in weights.bin")
        used.append((offset, offset + size, name))
        payload = raw[offset : offset + size]
        digest = record.get("sha256")
        if (
            not isinstance(digest, str)
            or len(digest) != 64
            or any(c not in "0123456789abcdef" for c in digest)
            or hashlib.sha256(payload).hexdigest() != digest
        ):
            raise AdapterError(
                f"tensor {name} fails its sha256 check; the artifact is corrupt or truncated"
            )
        values = np.frombuffer(payload, dtype=dtype).reshape(tuple(shape)).copy()
        if not np.isfinite(values).all():
            raise AdapterError(f"tensor {name} contains nonfinite values")
        if name == "feature_std" and not (values > 0).all():
            raise AdapterError("feature_std must be strictly positive")
        arrays[name] = values
    missing = [name for name in shapes if name not in arrays]
    if missing:
        raise AdapterError(f"model.json does not describe the required tensors {missing}")
    return checked, arrays


def canonical_weights_sha256(tensors):
    """sha256 over the W byte slice followed by the b byte slice, as stored."""
    parts = []
    for name in ("W", "b"):
        if name not in tensors:
            raise AdapterError(f"canonical hash needs tensor {name}")
        array = np.ascontiguousarray(tensors[name])
        if array.dtype.kind != "f" or array.dtype.itemsize not in (4, 8):
            raise AdapterError(f"tensor {name} must be a float32 or float64 array")
        parts.append(
            array.astype(array.dtype.newbyteorder("<"), copy=False).tobytes(order="C")
        )
    return hashlib.sha256(b"".join(parts)).hexdigest()


def to_manifest(document, tensors=None):
    """Build the interface manifest of a loaded artifact."""
    names = output_names(document)
    digest = None if tensors is None else canonical_weights_sha256(tensors)
    return DecoderManifest(
        name=document["adapter"]["name"],
        version=document["adapter"]["version"],
        kind=document["kind"],
        required_channels=tuple(document["channels"]),
        sample_rate_hz=document["sample_rate_hz"],
        epoch_window_s=document["window_samples"] / document["sample_rate_hz"],
        vocabulary=tuple(names) if document["kind"] == "text" else None,
        weights_sha256=digest,
        runtime="numpy",
        encoder="band_features",
        limits=dict(document["limits"]),
    )


def decode_features(features, weights, bias, vocabulary, abstain_threshold):
    """Pure float64 decode of one feature row per window.

    Softmax per slot, first-maximum argmax, abstain when the winning probability
    is below abstain_threshold. Window probability is the mean over slots and a
    window abstains when any slot abstains. This is the single decode path used
    both in memory and from an artifact, so the two agree bit-for-bit.
    """
    values = np.asarray(features, dtype=np.float64)
    tensor = np.asarray(weights, dtype=np.float64)
    offsets = np.asarray(bias, dtype=np.float64)
    names = list(vocabulary)
    if (
        values.ndim != 2
        or tensor.ndim != 3
        or offsets.shape != (tensor.shape[0], tensor.shape[2])
        or values.shape[1] != tensor.shape[1]
        or len(names) != tensor.shape[2]
    ):
        raise AdapterError("feature, weight and vocabulary shapes disagree")
    if isinstance(abstain_threshold, bool) or not isinstance(abstain_threshold, (int, float)):
        raise AdapterError("abstain_threshold must be a number")
    threshold = float(abstain_threshold)
    if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
        raise AdapterError("abstain_threshold must be between 0 and 1")
    if not (np.isfinite(values).all() and np.isfinite(tensor).all() and np.isfinite(offsets).all()):
        raise AdapterError("nonfinite features or weights cannot be decoded")
    count = values.shape[0]
    slots = tensor.shape[0]
    winners = np.empty((slots, count), dtype=np.int64)
    probabilities = np.empty((slots, count), dtype=np.float64)
    for slot in range(slots):
        logits = values @ tensor[slot] + offsets[slot]
        peak = logits.max(axis=1)
        exponent = np.exp(logits - peak[:, None])
        posterior = exponent / exponent.sum(axis=1)[:, None]
        chosen = posterior.argmax(axis=1)
        winners[slot] = chosen
        probabilities[slot] = posterior[np.arange(count), chosen]
    results = []
    for index in range(count):
        tokens = []
        abstained = False
        for slot in range(slots):
            probability = float(probabilities[slot, index])
            missed = probability < threshold
            abstained = abstained or missed
            tokens.append(
                {
                    "slot": slot,
                    "token": None if missed else names[int(winners[slot, index])],
                    "probability": probability,
                    "abstained": missed,
                }
            )
        results.append(
            {
                "label": None,
                "text": " ".join(
                    token["token"] if token["token"] is not None else "<abstain>"
                    for token in tokens
                ),
                "probability": float(np.mean([t["probability"] for t in tokens])),
                "tokens": tokens,
                "abstained": abstained,
            }
        )
    return results


def run_artifact(directory, windows):
    """Decode (windows, channels, window_samples) float32 windows from an artifact.

    Band features, optional z-score normalization, then decode_features. The
    arithmetic is identical to the in-memory adapter path.
    """
    document, tensors = load_artifact(directory)
    array = np.asarray(windows)
    if array.dtype.kind != "f" or array.dtype.itemsize not in (4, 8):
        raise AdapterError(
            f"windows must be a float32 or float64 array, received {array.dtype}"
        )
    if array.ndim != 3:
        raise AdapterError(
            f"windows must have shape (windows, channels, window_samples), received {array.shape}"
        )
    channels = document["channels"]
    if channels and array.shape[1] != len(channels):
        raise AdapterError(
            f"artifact {document['adapter']['name']} expects {len(channels)} channels "
            f"in this exact order: {channels[:8]}"
            f"{'' if len(channels) <= 8 else f' ... ({len(channels)} channels)'}; "
            f"received {array.shape[1]}"
        )
    if not channels and array.shape[1] * len(document["bands_hz"]) != document["feature_dim"]:
        raise AdapterError(
            f"artifact needs {document['feature_dim']} features = channels x "
            f"{len(document['bands_hz'])} bands; received {array.shape[1]} channels"
        )
    if array.shape[2] != document["window_samples"]:
        raise AdapterError(
            f"artifact needs {document['window_samples']} samples per window, "
            f"received {array.shape[2]}"
        )
    names = channels or [f"channel_{i}" for i in range(array.shape[1])]
    from .base import check_compatible

    check_compatible(to_manifest(document), names, document["sample_rate_hz"])
    features = band_features(
        array, document["bands_hz"], document["sample_rate_hz"], document["log_features"]
    )
    if document["normalize"]:
        mean = tensors["feature_mean"].astype(np.float64)
        deviation = tensors["feature_std"].astype(np.float64)
        features = (features - mean) / deviation
    return decode_features(
        features,
        tensors["W"],
        tensors["b"],
        output_names(document),
        document["abstain_threshold"],
    )
