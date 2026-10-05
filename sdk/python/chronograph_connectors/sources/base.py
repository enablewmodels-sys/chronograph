"""Spec-driven acquisition sources. A board or file format is a registry row.

Adding a device family, file format or transport means registering one
SourceSpec: an eager 'open(**options)' validator that returns an iterator of
StreamPlan values, each pairing a StreamDescriptor with an iterator of Chunk.
run_source is the only writer; it never infers units, sample rates or clock
domains, and it never rewrites the original source timestamps.

Only numpy and the standard library are imported at module import time. Optional
runtimes (mne, brainflow, pylsl) are imported inside the functions that need
them, so importing this package never fails on a machine without them.
"""

import math
from collections import namedtuple
from dataclasses import dataclass, field

import numpy as np

__all__ = [
    "CLOCK_DOMAINS",
    "SOURCES",
    "Chunk",
    "SourceSpec",
    "StreamDescriptor",
    "StreamPlan",
    "detect",
    "register_source",
    "run_source",
    "source",
    "source_ids",
    "synthetic_frames",
]

# Clock domains accepted by the BCI transport. "lsl_local_us" is a machine-local
# LSL clock, not Unix time; it is never silently treated as one.
CLOCK_DOMAINS = ("unix_us", "lsl_local_us", "device_us", "simulation_us")

# One stream of one source: metadata plus a lazy chunk iterator. open() yields
# these, so a single file or board can expose several streams (for example the
# default and auxiliary presets of a BrainFlow board).
StreamPlan = namedtuple("StreamPlan", "descriptor chunks")

_DTYPES = ("float32", "float64")


@dataclass(frozen=True)
class StreamDescriptor:
    """Stream metadata exactly as the source reports it."""

    channels: list
    units: list
    channel_types: list
    sample_rate_hz: float
    reference: str
    clock_domain: str
    source_clock: object
    modality: str
    provenance: dict = field(default_factory=dict)

    def __post_init__(self):
        if not 1 <= len(self.channels) <= 512:
            raise ValueError("A stream needs 1-512 channels")
        if len(set(self.channels)) != len(self.channels):
            raise ValueError("Channel names must be unique")
        if len(self.units) != len(self.channels) or len(self.channel_types) != len(
            self.channels
        ):
            raise ValueError("Units and channel types must match the channel count")
        if any(
            not isinstance(value, str) or not value
            for value in [*self.channels, *self.units, *self.channel_types]
        ):
            raise ValueError("Channel names, units and types must be nonempty strings")
        if (
            isinstance(self.sample_rate_hz, bool)
            or not isinstance(self.sample_rate_hz, (int, float))
            or not math.isfinite(self.sample_rate_hz)
            or not 0 < self.sample_rate_hz <= 100_000
        ):
            raise ValueError("Stream sample rate must be finite and within 0-100000 Hz")
        if self.clock_domain not in CLOCK_DOMAINS:
            raise ValueError(
                f"Unknown clock domain {self.clock_domain!r}; "
                f"expected one of {', '.join(CLOCK_DOMAINS)}"
            )
        if not isinstance(self.modality, str) or not self.modality:
            raise ValueError("A stream modality such as 'eeg', 'emg' or 'ppg' is required")
        if not isinstance(self.reference, str) or not self.reference:
            raise ValueError("An explicit reference label is required")
        if self.source_clock is not None and (
            not isinstance(self.source_clock, str) or not self.source_clock
        ):
            raise ValueError("source_clock must be a nonempty string or None")
        if not isinstance(self.provenance, dict):
            raise ValueError("Stream provenance must be a mapping")


@dataclass(frozen=True)
class Chunk:
    """One bounded block of samples in the source's own time base.

    'values' keeps the source reader's precision: float32 or float64, never
    silently rounded to the other. 'times' are original source seconds and are
    never rescaled. 'clocks' is additive and optional: it carries source clock
    measurements (as produced by an LSL inlet) so the generic writer can forward
    them without a special case.
    """

    values: np.ndarray
    times: np.ndarray
    sample_start: int
    segment_id: str
    correction_seconds: float = 0.0
    auxiliary: dict = field(default_factory=dict)
    events: list = field(default_factory=list)
    gaps: list = field(default_factory=list)
    clocks: list = field(default_factory=list)


@dataclass(frozen=True)
class SourceSpec:
    """One registry row: identity, file formats, detection and an opener."""

    id: str
    family: str
    formats: tuple
    description: str
    detect: object
    open: object


SOURCES = {}


def register_source(spec):
    """Register one source spec. Re-registering an identical id is an error."""
    if not isinstance(spec, SourceSpec):
        raise ValueError("register_source expects a SourceSpec")
    if not isinstance(spec.id, str) or not spec.id:
        raise ValueError("A source id is required")
    if spec.id in SOURCES:
        raise ValueError(f"Source {spec.id!r} is already registered")
    if not isinstance(spec.family, str) or not spec.family:
        raise ValueError(f"Source {spec.id!r} needs a family")
    if not isinstance(spec.formats, tuple) or any(
        not isinstance(value, str) or not value for value in spec.formats
    ):
        raise ValueError(f"Source {spec.id!r} needs a tuple of nonempty format labels")
    if not isinstance(spec.description, str) or not spec.description:
        raise ValueError(f"Source {spec.id!r} needs a description")
    if not callable(spec.detect) or not callable(spec.open):
        raise ValueError(f"Source {spec.id!r} needs callable detect and open")
    SOURCES[spec.id] = spec
    return spec


def source(id):
    """Look up a registered source spec by id."""
    try:
        return SOURCES[id]
    except (KeyError, TypeError):
        known = ", ".join(sorted(SOURCES)) or "<none>"
        raise ValueError(f"Unknown source {id!r}; registered sources: {known}") from None


def source_ids():
    """Registered source ids in registration order."""
    return tuple(SOURCES)


def detect(path):
    """Best-matching registered source id for a path, or None.

    Matching is by file suffix only: the longest suffix a spec declares wins, and
    a spec's own 'detect' callable may add non-suffix signals. Nothing about the
    file contents, units or sample rate is inferred here.
    """
    if path is None:
        return None
    name = str(path).lower()
    winner, winner_length = None, -1
    for spec in SOURCES.values():
        matched, size = False, -1
        for suffix in spec.formats:
            if suffix.startswith(".") and name.endswith(suffix.lower()):
                matched, size = True, max(size, len(suffix))
        if not matched:
            try:
                matched = bool(spec.detect(path))
            except Exception:
                matched = False
            size = 0 if matched else -1
        if matched and size > winner_length:
            winner, winner_length = spec.id, size
    return winner


def synthetic_frames(**options):
    """Deterministic synthetic plans; see the synthetic source module."""
    from .synthetic import synthetic_frames as build

    return build(**options)


def _us(value, what):
    """Bounded microsecond timestamp from an event/gap entry."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{what} must be an integer microsecond timestamp")
    if not math.isfinite(value):
        raise ValueError(f"{what} must be a finite microsecond timestamp")
    value = round(value)
    if not -(2**63) <= value < 2**63 - 1:
        raise ValueError(f"{what} exceeds i64 microseconds")
    return value


def _check_chunk(chunk, channels):
    """Validate one chunk against its descriptor before anything is written."""
    if not isinstance(chunk, Chunk):
        raise ValueError("A source must yield Chunk instances")
    values = np.asarray(chunk.values)
    times = np.asarray(chunk.times, dtype=np.float64)
    if values.dtype.name not in _DTYPES:
        raise ValueError("Chunk values must be float32 or float64")
    if (
        values.ndim != 2
        or times.ndim != 1
        or not len(times)
        or values.shape != (len(channels), len(times))
        or not np.isfinite(times).all()
        or np.any(np.diff(times) < 0)
    ):
        raise ValueError(
            "Chunk values must be [channels,samples] with one nondecreasing "
            "source timestamp per sample"
        )
    if type(chunk.sample_start) is not int or chunk.sample_start < 0:
        raise ValueError("Chunk sample_start must be a nonnegative integer")
    if not isinstance(chunk.segment_id, str) or not chunk.segment_id:
        raise ValueError("Chunk segment_id must be a nonempty string")
    if (
        isinstance(chunk.correction_seconds, bool)
        or not isinstance(chunk.correction_seconds, (int, float))
        or not math.isfinite(chunk.correction_seconds)
    ):
        raise ValueError("Chunk correction_seconds must be a finite number")
    if not isinstance(chunk.auxiliary, dict):
        raise ValueError("Chunk auxiliary must be a mapping")
    return values, times


def _write_signal(session, stream_id, chunk, values, times):
    """Write one chunk, delivering session.on_signal exactly once.

    A concrete session (chronograph_connectors.bci.Session) invokes its own
    on_signal from signal(). That internal delivery is suppressed around the
    write so the registered callback runs once per chunk, with the same
    corrected timestamps the session would have passed.
    """
    callback = getattr(session, "on_signal", None)
    kwargs = {
        "sample_start": chunk.sample_start,
        "segment_id": chunk.segment_id,
        "correction_seconds": chunk.correction_seconds,
        "auxiliary": chunk.auxiliary or None,
    }
    if callback is None:
        return session.signal(stream_id, values, times, **kwargs)
    suppressed = False
    try:
        session.on_signal = None
        suppressed = True
    except Exception:
        suppressed = False
    try:
        result = session.signal(stream_id, values, times, **kwargs)
    finally:
        if suppressed:
            try:
                session.on_signal = callback
            except Exception:
                pass
    if suppressed:
        # The session's own delivery was suppressed for this write, so deliver
        # exactly once here, with the same corrected timestamps it would pass.
        callback(stream_id, values, times + chunk.correction_seconds)
    return result


def _emit_event(session, stream_id, event):
    if not isinstance(event, dict):
        raise ValueError("Chunk events must be mappings")
    if "label" not in event:
        raise ValueError("Chunk events need a label")
    extra = {
        key: value
        for key, value in event.items()
        if key not in ("timestamp_us", "label", "category")
    }
    session.event(
        stream_id,
        _us(event.get("timestamp_us"), "Event timestamp_us"),
        str(event["label"]),
        category=str(event.get("category", "marker")),
        **extra,
    )


def _emit_gap(session, stream_id, gap):
    if not isinstance(gap, dict):
        raise ValueError("Chunk gaps must be mappings")
    start = _us(gap.get("start_us"), "Gap start_us")
    end = _us(gap.get("end_us"), "Gap end_us")
    if end < start:
        raise ValueError("A gap cannot end before it starts")
    reason = gap.get("reason")
    if not isinstance(reason, str) or not reason:
        raise ValueError("A gap needs a reason")
    lost = gap.get("lost_samples")
    if lost is not None and (
        isinstance(lost, bool) or not isinstance(lost, int) or lost < 0
    ):
        raise ValueError("lost_samples must be a nonnegative integer or None")
    session.gap(stream_id, start, end, reason=reason, lost_samples=lost)


def _emit_clock(session, stream_id, clock):
    if not isinstance(clock, dict):
        raise ValueError("Chunk clocks must be mappings")
    if "offset_seconds" not in clock or "source_clock" not in clock:
        raise ValueError("A clock measurement needs offset_seconds and source_clock")
    session.clock_measurement(
        stream_id,
        _us(clock.get("timestamp_us"), "Clock timestamp_us"),
        float(clock["offset_seconds"]),
        source_clock=str(clock["source_clock"]),
        uncertainty_seconds=clock.get("uncertainty_seconds"),
    )


def run_source(session, spec, **options):
    """Write one registered source into a session. The only generic writer.

    'spec' is a spec id or a SourceSpec. Every keyword in 'options' is forwarded
    to spec.open. Returns a summary of what was written; the caller owns session
    lifetime and fault handling.
    """
    if isinstance(spec, str):
        spec = source(spec)
    if not isinstance(spec, SourceSpec):
        raise ValueError("run_source expects a registered source id or SourceSpec")
    summary = {
        "source": spec.id,
        "streams": 0,
        "chunks": 0,
        "samples": 0,
        "events": 0,
        "gaps": 0,
        "clocks": 0,
    }
    for plan in spec.open(**options):
        if not isinstance(plan, StreamPlan) or not isinstance(
            plan.descriptor, StreamDescriptor
        ):
            raise ValueError("A source must yield StreamPlan(descriptor, chunks)")
        descriptor = plan.descriptor
        session_clock = getattr(session, "clock", None)
        if (
            descriptor.clock_domain in ("lsl_local_us", "device_us")
            and session_clock is not None
            and session_clock != descriptor.clock_domain
        ):
            raise ValueError(
                f"{spec.id} captures in {descriptor.clock_domain}; this session is "
                f"bound to {session_clock}. Create the session with the source clock."
            )
        stream_id = str(descriptor.provenance.get("stream_id") or descriptor.modality)
        session.stream(
            stream_id,
            channels=list(descriptor.channels),
            units=list(descriptor.units),
            channel_types=list(descriptor.channel_types),
            sample_rate_hz=descriptor.sample_rate_hz,
            reference=descriptor.reference,
            source_clock=descriptor.source_clock,
        )
        summary["streams"] += 1
        for chunk in plan.chunks:
            values, times = _check_chunk(chunk, descriptor.channels)
            _write_signal(session, stream_id, chunk, values, times)
            summary["chunks"] += 1
            summary["samples"] += len(times)
            for clock in chunk.clocks:
                _emit_clock(session, stream_id, clock)
                summary["clocks"] += 1
            for event in chunk.events:
                _emit_event(session, stream_id, event)
                summary["events"] += 1
            for gap in chunk.gaps:
                _emit_gap(session, stream_id, gap)
                summary["gaps"] += 1
    return summary
