"""Live LSL capture, adapted from bci_acquisition.lsl_capture.

The stream is resolved by source_id and exactly one match is required. The
nominal rate and channel count must match the explicit request and an optional
expected rate must match exactly. Original inlet timestamps are preserved; the
inlet time correction is carried on the chunk and one clock measurement is
forwarded per chunk. A gap (with no invented loss count) marks an interruption
and LostError/TimeoutError becomes an "LSL reconnecting" acquisition event.

This source captures in the machine-local lsl_local_us clock, so the generic
writer refuses to write it into a session bound to another clock domain. pylsl
is imported inside the functions below.
"""

import math
import time
import uuid

import numpy as np

from .base import Chunk, SourceSpec, StreamDescriptor, StreamPlan, register_source

REQUIRED_CLOCK = "lsl_local_us"


def open(
    *,
    source_id,
    channels,
    units,
    seconds=30,
    expected_rate=None,
    reference="unspecified",
    modality="eeg",
    stream_id="eeg",
    pull_samples=None,
):
    """Validate the explicit request and return one live LSL StreamPlan iterator.

    pull_samples sets how many samples one inlet read and one durable commit cover.
    It is the closed-loop knob: a 250 Hz sleep-stage or motor-imagery stream can
    commit a full half second instead of a quarter, quartering the commits per second
    while storing exactly the same samples. The inlet timeout stays 0.5 s, so a larger
    budget raises the worst-case read latency and never lowers it.
    """
    if not isinstance(source_id, str) or not source_id:
        raise ValueError("source_id must be a nonempty LSL stream source id")
    names = list(channels)
    if not 1 <= len(names) <= 512 or len(set(names)) != len(names):
        raise ValueError("Provide 1-512 unique channel names")
    if any(not isinstance(name, str) or not name for name in names):
        raise ValueError("Channel names must be nonempty strings")
    if isinstance(units, (str, bytes)) or len(units) != len(names):
        raise ValueError("Provide one explicit unit per channel; it is never inferred")
    unit_list = list(units)
    if any(not isinstance(unit, str) or not unit for unit in unit_list):
        raise ValueError("Units must be nonempty strings")
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not 0 < seconds <= 86400
    ):
        raise ValueError("seconds must be 0-86400")
    if expected_rate is not None and (
        isinstance(expected_rate, bool)
        or not isinstance(expected_rate, (int, float))
        or not math.isfinite(expected_rate)
        or not 80 <= expected_rate <= 100_000
    ):
        raise ValueError("expected_rate must be an explicit 80-100000 Hz rate")
    if not isinstance(reference, str) or not reference:
        raise ValueError("reference must be a nonempty label")
    if pull_samples is not None and (
        type(pull_samples) is not int or not 1 <= pull_samples <= 1_000_000
    ):
        raise ValueError("pull_samples must be an integer from 1 to 1000000")
    return _plans(
        source_id=source_id,
        names=names,
        unit_list=unit_list,
        seconds=seconds,
        expected_rate=expected_rate,
        reference=reference,
        modality=modality,
        stream_id=stream_id,
        pull_samples=pull_samples,
    )


def _plans(
    *,
    source_id,
    names,
    unit_list,
    seconds,
    expected_rate,
    reference,
    modality,
    stream_id,
    pull_samples=None,
):
    from pylsl import resolve_byprop

    until = time.monotonic() + seconds
    info = None
    while time.monotonic() < until:
        streams = resolve_byprop(
            "source_id", source_id, timeout=min(2, max(0.01, until - time.monotonic()))
        )
        if len(streams) > 1:
            raise ValueError("LSL source_id is ambiguous")
        if len(streams) == 1:
            info = streams[0]
            break
    if info is None:
        raise ValueError(
            f"No LSL stream with source_id {source_id!r} appeared within {seconds}s; "
            "nothing was captured"
        )
    rate = float(info.nominal_srate())
    if (
        rate <= 0
        or info.channel_count() != len(names)
        or (expected_rate is not None and rate != expected_rate)
    ):
        raise ValueError("LSL channel count/rate mismatch")
    descriptor = StreamDescriptor(
        channels=names,
        units=unit_list,
        channel_types=[str(modality).upper()] * len(names),
        sample_rate_hz=rate,
        reference=reference,
        clock_domain=REQUIRED_CLOCK,
        source_clock=source_id,
        modality=modality,
        provenance={
            "runtime": "pylsl",
            "source_id": source_id,
            "channel_count": int(info.channel_count()),
            "nominal_srate": rate,
            "channel_format": int(info.channel_format()),
            "clock_domain": REQUIRED_CLOCK,
            "stream_id": stream_id,
        },
    )
    yield StreamPlan(
        descriptor,
        _chunks(
            info,
            source_id=source_id,
            rate=rate,
            until=until,
            pull_samples=pull_samples,
        ),
    )


def _chunks(info, *, source_id, rate, until, pull_samples=None):
    from pylsl import StreamInlet, local_clock
    from pylsl.util import LostError, TimeoutError

    inlet = StreamInlet(info, max_buflen=60, recover=False, processing_flags=0)
    segment = uuid.uuid4().hex
    offset, last, pending = 0, None, None
    pending_events = []
    window = pull_samples or max(1, round(rate / 4))

    def reconnect():
        return {
            "timestamp_us": round(local_clock() * 1e6),
            "label": "LSL reconnecting",
            "category": "acquisition",
        }

    def read():
        correction = inlet.time_correction(timeout=2)
        samples, times = inlet.pull_chunk(timeout=0.5, max_samples=window)
        if not times:
            return None
        return (correction, samples, times)

    try:
        while True:
            if pending is None:
                if time.monotonic() >= until:
                    break
                try:
                    pending = read()
                except (LostError, TimeoutError):
                    pending_events.append(reconnect())
                    break
                if pending is None:
                    continue
            item, pending = pending, None
            stop_after = False
            # Look one batch ahead so an interruption is reported on the batch it
            # followed, which is when it actually happened.
            if time.monotonic() < until:
                try:
                    pending = read()
                except (LostError, TimeoutError):
                    pending_events.append(reconnect())
                    stop_after = True
            correction, samples, times = item
            first = (times[0] + correction) * 1e6
            gaps = []
            if last is not None and first - last > 3e6 / rate:
                gaps.append(
                    {
                        "start_us": round(last + 1e6 / rate),
                        "end_us": round(first),
                        "reason": "LSL interruption; loss count unknown",
                        "lost_samples": None,
                    }
                )
            yield Chunk(
                values=np.asarray(samples, dtype="<f4").T,
                times=np.asarray(times, dtype="<f8"),
                sample_start=offset,
                segment_id=segment,
                correction_seconds=correction,
                events=pending_events,
                gaps=gaps,
                clocks=[
                    {
                        "timestamp_us": round(local_clock() * 1e6),
                        "offset_seconds": float(correction),
                        "source_clock": source_id,
                        "uncertainty_seconds": None,
                    }
                ],
            )
            pending_events = []
            offset += len(times)
            last = (times[-1] + correction) * 1e6
            if stop_after:
                break
    finally:
        inlet.close_stream()


register_source(
    SourceSpec(
        id="lsl",
        family="live stream",
        formats=("lsl",),
        description=(
            "Live Lab Streaming Layer capture by source_id in the machine-local "
            "lsl_local_us clock, with clock measurements and loss honesty."
        ),
        detect=lambda path: False,
        open=open,
    )
)
