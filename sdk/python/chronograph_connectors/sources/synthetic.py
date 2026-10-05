"""Deterministic synthetic EEG, identical to bci_acquisition.synthetic.

No hardware, no randomness beyond the named seed and no inference: the generator
reproduces the historical construction byte for byte (rng seed 42, normal(0, 2e-6)
noise, per-channel 10 + amplitude sines, alternating left/right cues every four
seconds, chunk step rate // 4, unit "V").
"""

import time
import uuid

import numpy as np

from .base import Chunk, SourceSpec, StreamDescriptor, StreamPlan, register_source

DEFAULT_SEED = 42
NOISE_SIGMA_V = 2e-6
CUE_PERIOD_SECONDS = 4


def _bounds(channels, rate, seconds):
    if type(channels) is not int or not 1 <= channels <= 512:
        raise ValueError("Invalid synthetic recording bounds: channels must be 1-512")
    if type(rate) is not int or not 80 <= rate <= 100_000:
        raise ValueError(
            "Invalid synthetic recording bounds: rate must be an integer 80-100000 Hz"
        )
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not 0 < seconds <= 86400
    ):
        raise ValueError("Invalid synthetic recording bounds: seconds must be 0-86400")
    return round(seconds * rate)


def _chunk_step(rate, chunk_samples):
    """Validate an explicit samples-per-commit budget, or default to a quarter second."""
    if chunk_samples is None:
        return max(1, rate // 4)
    if type(chunk_samples) is not int or not 1 <= chunk_samples <= 1_000_000:
        raise ValueError("chunk_samples must be an integer from 1 to 1000000")
    return chunk_samples


def synthetic_chunks(
    *,
    channels,
    rate,
    total,
    start_us,
    segment,
    seed,
    realtime,
    chunk_samples=None,
):
    """Yield deterministic chunks; the only producer of synthetic samples.

    Generation is independent of publication. Samples are always drawn with the same
    internal block of a quarter second, and chunk_samples only decides how many of them
    travel in one durable commit: each chunk carries exactly chunk_samples samples
    except the last. The same seed, rate and duration therefore produce the same samples
    at every budget, so tuning commit frequency never rewrites a recording.
    """
    block = max(1, rate // 4)
    _chunk_step(rate, chunk_samples)
    emit = chunk_samples or block
    rng = np.random.default_rng(seed)
    began = time.monotonic()
    cue_period = CUE_PERIOD_SECONDS * rate
    values, times, marks = [], [], []
    buffered, published = 0, 0

    def take(count, marks):
        """Carry the cue events whose sample index falls inside this chunk."""
        head = [entry for entry in marks if entry[0] < published + count]
        return [entry[1] for entry in head]

    for offset in range(0, total, block):
        span = min(block, total - offset)
        index = np.arange(offset, offset + span)
        t = index / rate
        side = (index // cue_period) % 2
        signal = rng.normal(0, NOISE_SIGMA_V, (channels, span))
        for c in range(channels):
            amp = np.where(side == c % 2, 12e-6, 3e-6)
            signal[c] += amp * np.sin(2 * np.pi * (10 + (c // 2)) * t) + 1e-6 * np.sin(
                2 * np.pi * 22 * t
            )
        values.append(signal)
        times.append(t)
        marks.extend(
            (
                int(event),
                {
                    "timestamp_us": start_us + round(int(event) * 1e6 / rate),
                    "label": "left" if (event // cue_period) % 2 == 0 else "right",
                    "category": "cue",
                    "synthetic": True,
                },
            )
            for event in index[index % cue_period == 0]
        )
        buffered += span
        while buffered >= emit or buffered == total - published:
            count = min(emit, buffered)
            joined = np.concatenate(values, axis=1)
            head, tail = joined[:, :count], joined[:, count:]
            chunk_times = np.concatenate(times)[:count]
            if realtime:
                until = began + (published + count) / rate
                time.sleep(max(0, until - time.monotonic()))
            events = take(count, marks)
            yield Chunk(
                values=head.astype("<f4"),
                times=(start_us / 1e6 + chunk_times).astype("<f8"),
                sample_start=published,
                segment_id=segment,
                events=events,
            )
            marks = marks[len(events) :]
            published += count
            buffered -= count
            values = [tail] if tail.shape[1] else []
            times = [np.concatenate(times)[count:]] if tail.shape[1] else []
            if buffered == 0:
                break


def synthetic_frames(
    *,
    seconds=30,
    rate=250,
    channels=8,
    start_us=0,
    realtime=False,
    seed=DEFAULT_SEED,
    channel_names=None,
    reference="synthetic reference",
    clock_domain="unix_us",
    modality="eeg",
    stream_id="eeg",
    chunk_samples=None,
):
    """Return an iterator with one synthetic StreamPlan."""
    total = _bounds(channels, rate, seconds)
    if type(start_us) is not int or not 0 <= start_us < 2**63 - 1:
        raise ValueError("start_us must be a nonnegative i64 microsecond timestamp")
    if type(seed) is not int:
        raise ValueError("seed must be an integer")
    if type(realtime) is not bool:
        raise ValueError("realtime must be a boolean")
    names = list(channel_names) if channel_names else [
        f"EEG{i + 1:02d}" for i in range(channels)
    ]
    if len(names) != channels:
        raise ValueError("channel_names must provide exactly one name per channel")
    units = ["V"] * channels
    descriptor = StreamDescriptor(
        channels=names,
        units=units,
        channel_types=["EEG"] * channels,
        # The caller's own JSON form is preserved: 250 and 250.0 are different stream
        # declarations, and changing it would block resuming an existing spool.
        sample_rate_hz=rate,
        reference=reference,
        clock_domain=clock_domain,
        # None defers to the session clock, which is what the historical writer recorded.
        source_clock=None,
        modality=modality,
        provenance={
            "runtime": "chronograph-synthetic",
            "seed": seed,
            "channel_names_explicit": bool(channel_names),
            "clock_domain": clock_domain,
            "stream_id": stream_id,
        },
    )
    segment = uuid.uuid4().hex
    _chunk_step(rate, chunk_samples)
    return iter(
        [
            StreamPlan(
                descriptor,
                synthetic_chunks(
                    channels=channels,
                    rate=rate,
                    total=total,
                    start_us=start_us,
                    segment=segment,
                    seed=seed,
                    realtime=realtime,
                    chunk_samples=chunk_samples,
                ),
            )
        ]
    )


register_source(
    SourceSpec(
        id="synthetic",
        family="generator",
        formats=("synthetic",),
        description=(
            "Deterministic synthetic EEG with alternating left/right cues; the "
            "historical bci_acquisition.synthetic signal construction."
        ),
        detect=lambda path: False,
        open=synthetic_frames,
    )
)