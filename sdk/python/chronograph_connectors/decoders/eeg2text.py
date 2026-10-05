"""Reference EEG-to-text decoder (eeg2text-v1): honest, small, reproducible.

This is a plumbing reference, not a research model. It learns one deterministic
linear map per output slot by one-hot ridge least squares over shared band-power
features and decodes greedily, independently per slot. There is no language
model, no sequence model and no parity with any published EEG-to-text system
(SENSE, NeuroNarrator, EEG2Text and friends). Its scores on synthetic data
demonstrate that data flow, artifacts and abstention work, and say nothing about
human decoding accuracy. All of that is recorded in manifest limits.

Reproducibility: the solver is numpy.linalg.solve on float64
(X^T X + lambda I)^-1 X^T Y. There is no iterative or stochastic step, so a
fixed training set always yields identical weights; seed is accepted for
interface compatibility, is ignored, and that fact is recorded in limits.

Calibration warning: least squares on 0/1 targets reproduces class
probabilities, not margins, so a well-separated window ends with a winning
logit near 1.0 and the others near 0.0. Softmax then gives roughly 0.48 for a
four-token vocabulary and 0.25 for nine tokens, which means the conservative
default abstain_threshold of 0.6 abstains on everything but a two-token
vocabulary. That is deliberate honesty for an uncalibrated reference model: the
argmax (the decoded token) is what this model actually knows, and the
probability is not a calibrated confidence. Choose abstain_threshold on
validation data for a real deployment, and read the raw per-slot probabilities.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np

from . import portable
from .base import AdapterError, DecoderManifest, check_compatible
from .features import MAX_BANDS, band_features, band_list, feature_dim

NAME = "eeg2text-v1"
VERSION = "1"
DEFAULT_VOCABULARY = (
    "up",
    "down",
    "left",
    "right",
    "stop",
    "yes",
    "no",
    "select",
    "help",
)
DEFAULT_BANDS_HZ = (2.0, 6.0, 10.0, 20.0, 40.0)
DEFAULT_ABSTAIN_THRESHOLD = 0.6
DEFAULT_RIDGE = 1e-2
DEFAULT_SAMPLE_RATE_HZ = 250.0
DEFAULT_EPOCH_WINDOW_S = 1.0
DEFAULT_HOP_S = 0.5
MAX_EPOCHS = 1 << 16
MAX_ELEMENTS = 1 << 25
MAX_VOCABULARY_FILE_BYTES = 1 << 20


def load_vocabulary(path):
    """Load a closed vocabulary from a small JSON file.

    Accepts either a JSON array of strings or an object with a "vocabulary"
    array. Pickles and arbitrary Python objects are never loaded.
    """
    source = Path(path)
    if source.is_symlink() or not source.is_file():
        raise AdapterError(f"vocabulary file {source} must be a regular local file")
    size = source.stat().st_size
    if size > MAX_VOCABULARY_FILE_BYTES:
        raise AdapterError(
            f"vocabulary file is {size} bytes, above the bound of {MAX_VOCABULARY_FILE_BYTES}"
        )
    try:
        data = json.loads(source.read_bytes())
    except (ValueError, UnicodeDecodeError) as error:
        raise AdapterError(f"vocabulary file {source.name} is not valid UTF-8 JSON: {error}") from None
    if isinstance(data, dict):
        data = data.get("vocabulary")
    if not isinstance(data, list):
        raise AdapterError(
            "vocabulary JSON must be an array of strings, or an object with a "
            "'vocabulary' array"
        )
    names = tuple(
        item for item in data if isinstance(item, str) and item and len(item) <= 256
    )
    if len(names) != len(data):
        raise AdapterError("every vocabulary entry must be a nonempty string of at most 256 characters")
    if not 2 <= len(names) <= 4096 or len(set(names)) != len(names):
        raise AdapterError("vocabulary needs 2..4096 unique nonempty token strings")
    return names


def _tokens(label, slots):
    parts = label.split()
    if not parts:
        raise AdapterError("every label must hold at least one whitespace-separated token")
    if len(parts) > slots:
        raise AdapterError(
            f"label {label!r} holds {len(parts)} tokens but the decoder has {slots} slots; "
            "call fit(..., slots=...) to size the decoder"
        )
    return parts


class EEG2TextDecoder:
    """Closed-vocabulary, greedy, per-slot linear decoder over band features."""

    name = NAME
    version = VERSION
    default_vocabulary = DEFAULT_VOCABULARY
    default_bands_hz = DEFAULT_BANDS_HZ

    def __init__(
        self,
        *,
        channels=(),
        sample_rate_hz=DEFAULT_SAMPLE_RATE_HZ,
        epoch_window_s=DEFAULT_EPOCH_WINDOW_S,
        hop_s=DEFAULT_HOP_S,
        bands_hz=None,
        log_features=True,
        vocabulary=None,
        abstain_threshold=DEFAULT_ABSTAIN_THRESHOLD,
        normalize=True,
        ridge=DEFAULT_RIDGE,
        slots=None,
        runtime="numpy",
        limits=None,
    ):
        rate = float(sample_rate_hz)
        window = float(epoch_window_s)
        if not math.isfinite(rate) or rate <= 0:
            raise AdapterError("sample_rate_hz must be a finite positive number")
        if not math.isfinite(window) or window <= 0:
            raise AdapterError("epoch_window_s must be a finite positive number")
        hop = float(hop_s)
        if not math.isfinite(hop) or hop <= 0:
            raise AdapterError("hop_s must be a finite positive number")
        bands = band_list(DEFAULT_BANDS_HZ if bands_hz is None else bands_hz, rate)
        if len(bands) > MAX_BANDS:
            raise AdapterError(f"at most {MAX_BANDS} band centers are supported")
        if not isinstance(log_features, bool) or not isinstance(normalize, bool):
            raise AdapterError("log_features and normalize must be bools")
        threshold = float(abstain_threshold)
        if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
            raise AdapterError("abstain_threshold must be between 0 and 1")
        ridge_value = float(ridge)
        if not math.isfinite(ridge_value) or ridge_value < 0:
            raise AdapterError("ridge must be a finite nonnegative number")
        if slots is not None and (
            isinstance(slots, bool) or not isinstance(slots, int) or not 1 <= slots <= 64
        ):
            raise AdapterError("slots must be an integer in 1..64")
        if vocabulary is None:
            vocabulary = DEFAULT_VOCABULARY
        manifest = DecoderManifest(
            name=NAME,
            version=VERSION,
            kind="text",
            required_channels=tuple(channels),
            sample_rate_hz=rate,
            epoch_window_s=window,
            vocabulary=tuple(vocabulary),
            runtime=runtime,
            encoder="band_features",
            limits=self._untrained_limits(limits, bands, log_features, normalize, threshold, ridge_value),
        )
        self._manifest = manifest
        self._rate = rate
        self._window = window
        self._samples = max(1, int(round(window * rate)))
        self._hop = max(1, int(round(hop * rate)))
        self._bands = tuple(bands)
        self._log_features = log_features
        self._normalize = normalize
        self._threshold = threshold
        self._ridge = ridge_value
        self._slots = slots if slots is not None else int(manifest.limits.get("slots", 1))
        self._base_limits = dict(limits or {})
        self._vocabulary = tuple(manifest.vocabulary)
        self._weights = None
        self._bias = None
        self._mean = None
        self._std = None
        self._directory = None
        self._trained_groups = ()

    @staticmethod
    def _untrained_limits(extra, bands, log_features, normalize, threshold, ridge):
        limits = dict(extra or {})
        limits.setdefault("model", "deterministic per-slot one-hot ridge least squares over band-power features")
        limits.setdefault("configuration", "untrained")
        limits.setdefault("bands_hz", [float(b) for b in bands])
        limits.setdefault("log_features", bool(log_features))
        limits.setdefault("normalize", bool(normalize))
        limits.setdefault("abstain_threshold", float(threshold))
        limits.setdefault("ridge_lambda", float(ridge))
        limits.setdefault("seed_used", False)
        limits.setdefault("seed_note", "the solver is deterministic and ignores seed; no stochastic step exists")
        limits.setdefault("reference_only", True)
        limits.setdefault(
            "claims",
            [
                "closed vocabulary: input outside the vocabulary cannot be decoded",
                "greedy independent per-slot decoding; no sequence model, grammar or language prior",
                "no parity with SENSE, NeuroNarrator, EEG2Text or any published EEG-to-text model",
                "not a communication aid, not a clinical or diagnostic device",
                "scores on synthetic data test plumbing only; they make no claim about human accuracy",
                "softmax probabilities are uncalibrated: on well-separated windows the winning "
                "probability sits near 1/(1+exp(-1)) scaled by the vocabulary size (about 0.48 for "
                "four tokens, 0.25 for nine), so the default 0.6 threshold abstains by design; "
                "pick abstain_threshold on validation data",
            ],
        )
        return limits

    # ---------------------------------------------------------------- interface

    def manifest(self):
        return self._manifest

    def fit(
        self,
        epochs,
        labels,
        groups,
        *,
        seed=0,
        vocabulary=None,
        slots=None,
        bands_hz=None,
        log_features=None,
        normalize=None,
        abstain_threshold=None,
        ridge=None,
    ):
        """Fit one ridge map per slot on the provided training epochs only.

        The caller owns the split: fit uses every epoch it is given, and groups
        are validated and recorded so a caller that held groups out can show that
        training never saw them. Returns None; fitted state lives on the adapter.
        """
        values = self._check_epochs(epochs, "fit")
        count = values.shape[0]
        if isinstance(labels, (str, bytes)) or not hasattr(labels, "__len__"):
            raise AdapterError("labels must be a sequence with one string per epoch")
        labels = list(labels)
        if len(labels) != count:
            raise AdapterError(f"labels must hold {count} entries, received {len(labels)}")
        if any(not isinstance(label, str) or not label.strip() for label in labels):
            raise AdapterError("every label must be a nonempty token string")
        if isinstance(groups, (str, bytes)) or not hasattr(groups, "__len__"):
            raise AdapterError("groups must be a sequence with one id per epoch")
        groups = list(groups)
        if len(groups) != count:
            raise AdapterError(f"groups must hold {count} entries, received {len(groups)}")
        if any(not isinstance(group, str) or not group for group in groups):
            raise AdapterError("every group id must be a nonempty string")
        bands = self._bands if bands_hz is None else band_list(bands_hz, self._rate)
        use_log = self._log_features if log_features is None else log_features
        use_normalize = self._normalize if normalize is None else normalize
        if not isinstance(use_log, bool) or not isinstance(use_normalize, bool):
            raise AdapterError("log_features and normalize must be bools")
        threshold = self._threshold if abstain_threshold is None else abstain_threshold
        threshold = float(threshold)
        if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
            raise AdapterError("abstain_threshold must be between 0 and 1")
        ridge_value = self._ridge if ridge is None else float(ridge)
        if not math.isfinite(ridge_value) or ridge_value < 0:
            raise AdapterError("ridge must be a finite nonnegative number")
        if vocabulary is None:
            names = self._vocabulary
        else:
            names = tuple(vocabulary)
            if not 2 <= len(names) <= 4096 or len(set(names)) != len(names) or any(
                not isinstance(item, str) or not item or len(item) > 256 for item in names
            ):
                raise AdapterError(
                    "vocabulary must hold 2..4096 unique nonempty token strings"
                )
        dim = feature_dim(values.shape[1], bands)
        if dim > portable.MAX_FEATURE_DIM:
            raise AdapterError(
                f"{values.shape[1]} channels x {len(bands)} bands = {dim} features, "
                f"above the bound of {portable.MAX_FEATURE_DIM}"
            )
        if slots is None:
            slots = self._slots
            detected = max(len(label.split()) for label in labels)
            slots = max(slots, detected)
        if isinstance(slots, bool) or not isinstance(slots, int) or not 1 <= slots <= 64:
            raise AdapterError("slots must be an integer in 1..64")
        index = {token: position for position, token in enumerate(names)}
        tokenized = [_tokens(label, slots) for label in labels]
        unknown = sorted({token for parts in tokenized for token in parts if token not in index})
        if unknown:
            raise AdapterError(
                f"labels use {len(unknown)} token(s) outside the vocabulary, for example "
                f"{unknown[:8]}; pass fit(..., vocabulary=...) with the full closed vocabulary"
            )
        features = band_features(values, bands, self._rate, use_log)
        if use_normalize:
            mean = features.mean(axis=0)
            deviation = features.std(axis=0)
            deviation[deviation == 0] = 1.0
            features = (features - mean) / deviation
        else:
            mean = np.zeros(dim, dtype=np.float64)
            deviation = np.ones(dim, dtype=np.float64)
        width = len(names)
        weights = np.zeros((slots, dim, width), dtype=np.float64)
        bias = np.zeros((slots, width), dtype=np.float64)
        trained = []
        for slot in range(slots):
            rows = [i for i, parts in enumerate(tokenized) if len(parts) > slot]
            trained.append(len(rows))
            if not rows:
                continue
            design = features[rows]
            target = np.zeros((len(rows), width), dtype=np.float64)
            for position, row in enumerate(rows):
                target[position, index[tokenized[row][slot]]] = 1.0
            gram = design.T @ design
            gram += ridge_value * np.eye(dim, dtype=np.float64)
            weights[slot] = np.linalg.solve(gram, design.T @ target)
            bias[slot] = target.mean(axis=0) - design.mean(axis=0) @ weights[slot]
        self._weights = np.ascontiguousarray(weights.astype("<f4"))
        self._bias = np.ascontiguousarray(bias.astype("<f4"))
        self._mean = np.ascontiguousarray(mean.astype("<f4"))
        self._std = np.ascontiguousarray(deviation.astype("<f4"))
        self._vocabulary = names
        self._bands = tuple(bands)
        self._log_features = use_log
        self._normalize = use_normalize
        self._threshold = threshold
        self._ridge = ridge_value
        self._slots = slots
        self._trained_groups = tuple(sorted(set(groups)))
        self._directory = None
        digest = portable.canonical_weights_sha256({"W": self._weights, "b": self._bias})
        limits = self._untrained_limits(
            self._base_limits, self._bands, self._log_features, self._normalize, threshold, ridge_value
        )
        limits.update(
            {
                "configuration": "fitted",
                "slots": slots,
                "slots_trained": trained,
                "vocabulary_size": len(names),
                "feature_dim": dim,
                "window_samples": self._samples,
                "hop_samples": self._hop,
                "train_epochs": count,
                "train_groups": list(self._trained_groups),
                "seed": int(seed),
                "weights_sha256": digest,
                "weights_sha256_definition": "sha256 of the little-endian f32 byte slices of W then b, C order",
            }
        )
        self._manifest = self._manifest.replace(
            vocabulary=names, weights_sha256=digest, limits=limits
        )

    def predict(self, epochs):
        values = self._check_epochs(epochs, "predict")
        if self._weights is None:
            raise AdapterError(
                f"{NAME} must be fitted or loaded before predict; call fit(...) or "
                f"{NAME}.load(directory)"
            )
        features = self._features(values)
        return portable.decode_features(
            features, self._weights, self._bias, self._vocabulary, self._threshold
        )

    def predict_windows(self, windows):
        """Decode with the saved artifact executor, matching the Rust path."""
        if self._directory is None:
            raise AdapterError(
                "save(directory) before predict_windows(); the portable executor "
                "reads model.json and weights.bin from disk"
            )
        return portable.run_artifact(self._directory, windows)

    # ------------------------------------------------------------------ artifact

    def document(self):
        """model.json document for this decoder (tensors are filled in by save)."""
        if self._weights is None:
            raise AdapterError("fit or load the decoder before building an artifact document")
        return {
            "format": portable.FORMAT,
            "adapter": {"name": NAME, "version": VERSION},
            "kind": "text",
            "sample_rate_hz": self._rate,
            "channels": list(self._manifest.required_channels),
            "window_samples": self._samples,
            "hop_samples": self._hop,
            "bands_hz": [float(band) for band in self._bands],
            "log_features": self._log_features,
            "feature_dim": int(self._weights.shape[1]),
            "slots": int(self._weights.shape[0]),
            "vocabulary": list(self._vocabulary),
            "labels": None,
            "abstain_threshold": self._threshold,
            "normalize": self._normalize,
            "tensors": [],
            "limits": dict(self._manifest.limits),
        }

    def tensors(self):
        if self._weights is None:
            raise AdapterError("fit or load the decoder before saving tensors")
        values = {"W": self._weights, "b": self._bias}
        if self._normalize:
            values["feature_mean"] = self._mean
            values["feature_std"] = self._std
        return values

    def save(self, directory):
        """Write a decoder-v1 artifact and return its directory path."""
        path = portable.save_artifact(directory, self.document(), self.tensors())
        self._directory = path
        return path

    @classmethod
    def load(cls, directory):
        """Load a decoder-v1 artifact, verifying every tensor checksum."""
        document, tensors = portable.load_artifact(directory)
        if document["kind"] != "text":
            raise AdapterError(
                f"artifact kind is {document['kind']!r}; {NAME} loads text artifacts only"
            )
        names = tuple(portable.output_names(document))
        decoder = cls(
            channels=tuple(document["channels"]),
            sample_rate_hz=document["sample_rate_hz"],
            epoch_window_s=document["window_samples"] / document["sample_rate_hz"],
            hop_s=document["hop_samples"] / document["sample_rate_hz"],
            bands_hz=tuple(document["bands_hz"]),
            log_features=document["log_features"],
            vocabulary=names,
            abstain_threshold=document["abstain_threshold"],
            normalize=document["normalize"],
            slots=document["slots"],
            limits=dict(document["limits"]),
        )
        decoder._weights = tensors["W"]
        decoder._bias = tensors["b"]
        decoder._mean = tensors.get("feature_mean")
        decoder._std = tensors.get("feature_std")
        decoder._slots = int(document["slots"])
        decoder._samples = int(document["window_samples"])
        decoder._hop = int(document["hop_samples"])
        decoder._directory = str(directory)
        decoder._trained_groups = tuple(document["limits"].get("train_groups") or ())
        digest = portable.canonical_weights_sha256({"W": decoder._weights, "b": decoder._bias})
        decoder._manifest = decoder._manifest.replace(
            weights_sha256=digest,
            required_channels=tuple(document["channels"]),
        )
        return decoder

    # ------------------------------------------------------------------ internals

    def _check_epochs(self, epochs, what):
        array = np.asarray(epochs)
        if array.dtype.kind != "f" or array.dtype.itemsize not in (4, 8):
            raise AdapterError(
                f"{what} epochs must be a float32 or float64 array, received {array.dtype}"
            )
        if array.ndim != 3:
            raise AdapterError(
                f"{what} epochs must have shape (epochs, channels, samples), "
                f"received {array.shape}"
            )
        count, channels, samples = array.shape
        if count < 1 or channels < 1:
            raise AdapterError(f"{what} needs at least one epoch and one channel")
        if count > MAX_EPOCHS or count * channels * samples > MAX_ELEMENTS:
            raise AdapterError(
                f"{what} received {count} epochs of {channels}x{samples}, above the bounded budget"
            )
        if samples != self._samples:
            raise AdapterError(
                f"{what} epochs need {self._samples} samples per window "
                f"({self._window:g} s at {self._rate:g} Hz), received {samples}"
            )
        values = np.ascontiguousarray(array, dtype=np.float32)
        if not np.isfinite(values).all():
            raise AdapterError(
                f"{what} epochs contain nonfinite samples; reject gaps and artifacts first"
            )
        check_compatible(self._manifest, channels, self._rate)
        if not self._manifest.required_channels:
            width = self._weights.shape[1] if self._weights is not None else feature_dim(channels, self._bands)
            if channels * len(self._bands) != width:
                raise AdapterError(
                    f"{NAME} needs {width // len(self._bands)} channels x {len(self._bands)} "
                    f"bands; received {channels} channels"
                )
        return values

    def _features(self, values):
        features = band_features(values, self._bands, self._rate, self._log_features)
        if self._normalize:
            mean = np.asarray(self._mean, dtype=np.float64)
            deviation = np.asarray(self._std, dtype=np.float64)
            features = (features - mean) / deviation
        return features


def adapter():
    """Registry factory for the reference decoder."""
    return EEG2TextDecoder()
