"""Pluggable decoder adapter interface for the BCI research workspace.

A decoder adapter turns one bounded EEG epoch into either a class label or a
text token sequence. The interface is deliberately narrow:

    class DecoderAdapter(Protocol):
        def manifest(self) -> DecoderManifest: ...
        def fit(self, epochs, labels, groups, *, seed=0) -> None: ...
        def predict(self, epochs) -> list[dict]: ...

Data conventions (a conforming adapter never deviates from these):

epochs
    float32 NumPy array shaped (n_epochs, n_channels, n_samples), C order.
    Channel order is the adapter's required_channels order; n_samples is
    round(epoch_window_s * sample_rate_hz). Nonfinite samples, irregular
    timing, and epochs crossing a gap or an artifact/bad-channel span must be
    rejected by the caller before fit or predict. The house convention for that
    rejection lives in chronograph_connectors.bci_training and is reused
    unchanged.
labels
    One string per epoch: a class label when kind == "classification", or the
    token string of that epoch when kind == "text".
groups
    One participant or session identifier per epoch. Groups exist for splitting
    only. An adapter must never train on epochs from a group it holds out, and
    must never fold evaluation-group statistics into a saved model. Prefer
    participant ids when at least three distinct participants exist, otherwise
    session ids (the rule used by bci_training).

Adapters are pure local code: no server access, no pickle, no secrets. Numeric
artifacts are checksummed files; see chronograph_connectors.decoders.portable.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from typing import Any, Protocol, runtime_checkable

KINDS = ("classification", "text")
MAX_CHANNELS = 512
MAX_VOCABULARY = 4096
MAX_SLOTS = 64
MAX_LIMITS_BYTES = 64 * 1024
_NAME_LIMIT = 256


class AdapterError(ValueError):
    """Actionable decoder failure that is safe to show a user (never a secret).

    Raised for a wrong montage or sample rate, a missing or inconsistent
    artifact, a nonfinite input, or an adapter asked to predict before it was
    fitted or loaded. Messages name the concrete requirement so a caller can fix
    the input instead of guessing.
    """


def _label(value: Any, what: str, *, limit: int = _NAME_LIMIT) -> str:
    if not isinstance(value, str) or not value or len(value) > limit:
        raise AdapterError(
            f"{what} must be a nonempty string of at most {limit} characters"
        )
    return value


def _names(
    values: Any, what: str, *, maximum: int, allow_empty: bool = True, unique: bool = True
) -> tuple:
    if values is None:
        values = ()
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise AdapterError(f"{what} must be a sequence of names")
    items = tuple(_label(v, what) for v in values)
    if len(items) > maximum:
        raise AdapterError(
            f"{what} accepts at most {maximum} entries, received {len(items)}"
        )
    if unique and len(set(items)) != len(items):
        raise AdapterError(f"{what} must not repeat a name")
    if not items and not allow_empty:
        raise AdapterError(f"{what} must not be empty")
    return items


def _finite(value: Any, what: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AdapterError(f"{what} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise AdapterError(f"{what} must be finite")
    return number


def _json_safe(value: Any, what: str) -> Any:
    try:
        encoded = json.dumps(value, allow_nan=False, sort_keys=True)
    except (TypeError, ValueError):
        raise AdapterError(f"{what} must contain only JSON-compatible values") from None
    if len(encoded) > MAX_LIMITS_BYTES:
        raise AdapterError(f"{what} exceeds {MAX_LIMITS_BYTES} bytes")
    return value


@dataclass(frozen=True)
class DecoderManifest:
    """Identity, montage, timing and honesty limits of one decoder adapter.

    sample_rate_hz <= 0 or epoch_window_s <= 0 means "not fixed yet" (typically
    an untrained adapter); check_compatible then skips that comparison instead
    of inventing a value. required_channels == () means the adapter accepts any
    montage and validates only its own feature width.
    """

    name: str
    version: str
    kind: str
    required_channels: tuple = ()
    sample_rate_hz: float = 0.0
    epoch_window_s: float = 0.0
    vocabulary: tuple | None = None
    weights_sha256: str | None = None
    runtime: str = "numpy"
    encoder: str | None = None
    limits: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        _label(self.name, "manifest name")
        _label(self.version, "manifest version")
        if self.kind not in KINDS:
            raise AdapterError(
                f"manifest kind must be one of {KINDS}, received {self.kind!r}"
            )
        object.__setattr__(
            self,
            "required_channels",
            _names(self.required_channels, "required_channels", maximum=MAX_CHANNELS),
        )
        rate = _finite(self.sample_rate_hz, "sample_rate_hz")
        window = _finite(self.epoch_window_s, "epoch_window_s")
        if rate < 0 or window < 0:
            raise AdapterError("sample_rate_hz and epoch_window_s must not be negative")
        object.__setattr__(self, "sample_rate_hz", rate)
        object.__setattr__(self, "epoch_window_s", window)
        if self.vocabulary is not None:
            object.__setattr__(
                self,
                "vocabulary",
                _names(
                    self.vocabulary,
                    "vocabulary",
                    maximum=MAX_VOCABULARY,
                    allow_empty=False,
                ),
            )
        if self.weights_sha256 is not None:
            digest = self.weights_sha256
            if (
                not isinstance(digest, str)
                or len(digest) != 64
                or any(c not in "0123456789abcdef" for c in digest)
            ):
                raise AdapterError("weights_sha256 must be 64 lowercase hex characters")
        _label(self.runtime, "manifest runtime")
        if self.encoder is not None:
            _label(self.encoder, "manifest encoder")
        if not isinstance(self.limits, dict) or any(
            not isinstance(k, str) for k in self.limits
        ):
            raise AdapterError("limits must be a dict with string keys")
        object.__setattr__(self, "limits", _json_safe(dict(self.limits), "limits"))

    def replace(self, **changes: Any) -> DecoderManifest:
        """Field-wise copy; validation runs again on the result."""
        return replace(self, **changes)

    def to_dict(self) -> dict:
        """JSON-compatible manifest, also used by describe_all()."""
        return {
            "name": self.name,
            "version": self.version,
            "kind": self.kind,
            "required_channels": list(self.required_channels),
            "sample_rate_hz": self.sample_rate_hz,
            "epoch_window_s": self.epoch_window_s,
            "vocabulary": None if self.vocabulary is None else list(self.vocabulary),
            "weights_sha256": self.weights_sha256,
            "runtime": self.runtime,
            "encoder": self.encoder,
            "limits": dict(self.limits),
        }

    @classmethod
    def from_dict(cls, data: dict) -> DecoderManifest:
        if not isinstance(data, dict):
            raise AdapterError("manifest record must be a dict")
        missing = [key for key in ("name", "version", "kind") if key not in data]
        if missing:
            raise AdapterError(f"manifest record is missing {missing}")
        return cls(
            name=data["name"],
            version=data["version"],
            kind=data["kind"],
            required_channels=tuple(data.get("required_channels") or ()),
            sample_rate_hz=data.get("sample_rate_hz", 0.0),
            epoch_window_s=data.get("epoch_window_s", 0.0),
            vocabulary=None
            if data.get("vocabulary") is None
            else tuple(data["vocabulary"]),
            weights_sha256=data.get("weights_sha256"),
            runtime=data.get("runtime", "numpy"),
            encoder=data.get("encoder"),
            limits=dict(data.get("limits") or {}),
        )


def describe_required(manifest: DecoderManifest, *, shown: int = 8) -> str:
    """Bounded human-readable description of a manifest's montage and rate."""
    channels = manifest.required_channels
    if not channels:
        montage = "any channel count"
    else:
        head = ", ".join(channels[:shown])
        more = "" if len(channels) <= shown else f", ... ({len(channels)} total)"
        montage = f"{len(channels)} channels in this exact order [{head}{more}]"
    rate = (
        "sample rate not fixed yet"
        if manifest.sample_rate_hz <= 0
        else f"{manifest.sample_rate_hz:g} Hz"
    )
    return f"{manifest.name} requires {montage} at {rate}"


def check_compatible(manifest: DecoderManifest, channels, sample_rate_hz=None) -> None:
    """Raise AdapterError unless montage order and rate match the manifest.

    channels is a sequence of channel names (order matters) or an integer
    channel count. sample_rate_hz may be None to skip the rate check. Call this
    before any fit or predict so a mismatched montage fails with an actionable
    message instead of a silently wrong prediction.
    """
    if not isinstance(manifest, DecoderManifest):
        raise AdapterError("check_compatible requires a DecoderManifest")
    if channels is None:
        raise AdapterError(f"{describe_required(manifest)}; no channels were supplied")
    if isinstance(channels, (bool, int)):
        count = int(channels)
        if count < 1 or count > MAX_CHANNELS:
            raise AdapterError(
                f"channel count must be 1..{MAX_CHANNELS}, received {count}"
            )
        names = None
    else:
        names = _names(channels, "channels", maximum=MAX_CHANNELS, allow_empty=False)
        count = len(names)
    required = manifest.required_channels
    if required and count != len(required):
        raise AdapterError(
            f"{manifest.name} expects {len(required)} channels but received {count}; "
            f"required montage: {describe_required(manifest)}"
        )
    if required and names is not None and tuple(names) != required:
        tail = "" if len(required) <= 8 else f" ... ({len(required)} channels)"
        seen = "" if len(names) <= 8 else f" ... ({len(names)} channels)"
        raise AdapterError(
            f"{manifest.name} requires this exact channel order: "
            f"{list(required[:8])}{tail}; received: {list(names[:8])}{seen}"
        )
    if sample_rate_hz is not None:
        rate = _finite(sample_rate_hz, "sample_rate_hz")
        if rate <= 0:
            raise AdapterError("sample_rate_hz must be positive")
        want = manifest.sample_rate_hz
        if want > 0 and abs(rate - want) > max(1e-3, 1e-6 * want):
            raise AdapterError(
                f"{manifest.name} was fitted at {want:g} Hz but received {rate:g} Hz; "
                "resample explicitly or use a model trained at this rate"
            )


@runtime_checkable
class DecoderAdapter(Protocol):
    """The pluggable contract every decoder implements.

    Implementations must be deterministic for a fixed input and seed, must keep
    predict free of fitted state changes, and must be honest in limits about
    what the model does not claim (research-model parity, clinical use, accuracy
    on unseen human participants, and so on).
    """

    def manifest(self) -> DecoderManifest:
        """Return the adapter's current identity, montage, timing and limits."""
        ...

    def fit(self, epochs, labels, groups, *, seed: int = 0) -> None:
        """Fit on training epochs only.

        epochs is float32 (n_epochs, n_channels, n_samples), labels is one
        string per epoch, groups is one participant/session id per epoch and is
        used for splitting, never for leakage. seed seeds any stochastic step; a
        fully deterministic solver may ignore it but must record that fact in
        its manifest limits.
        """
        ...

    def predict(self, epochs) -> list:
        """Return one dict per epoch.

        Keys: label (str | None), text (str | None), probability (float),
        tokens (list[dict] | None), abstained (bool). Token dicts carry slot,
        token (str | None), probability and abstained. A text adapter sets label
        to None; a classification adapter sets text and tokens to None.
        """
        ...


def group_holdout(groups, *, held_out_fraction: float = 0.25):
    """Split epoch positions by group, deterministically, without leakage.

    Groups are sorted and the last max(1, ceil(held_out_fraction * n_groups))
    groups are held out, mirroring the bci_training convention ("sorted last
    quarter held out"). Pass participant ids when at least three distinct
    participants exist, otherwise session ids.

    Returns (train_indices, holdout_indices) as two lists of positions, so that
    they can be used directly for NumPy fancy indexing. Raises AdapterError when
    fewer than two groups exist or the holdout would leave no training group.
    """
    values = _names(groups, "groups", maximum=1_000_000, allow_empty=False, unique=False)
    fraction = _finite(held_out_fraction, "held_out_fraction")
    if not 0.0 < fraction < 1.0:
        raise AdapterError("held_out_fraction must be strictly between 0 and 1")
    unique = sorted(set(values))
    if len(unique) < 2:
        raise AdapterError(
            "At least two independent groups are required to hold one out; "
            "record more participants or sessions"
        )
    hold = min(max(1, math.ceil(fraction * len(unique))), len(unique) - 1)
    test_groups = set(unique[-hold:])
    train = [i for i, g in enumerate(values) if g not in test_groups]
    test = [i for i, g in enumerate(values) if g in test_groups]
    return train, test
