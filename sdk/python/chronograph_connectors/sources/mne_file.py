"""Recorded EEG files read through explicit MNE readers. No pickle, no reloading.

EDF, BDF, FIF, BrainVision (.vhdr) and EEGLAB (.set) are opened with the named
MNE reader for the suffix, always with preload=False so a large recording is
never loaded into memory as a whole. Only voltage channels are kept (EEG, EOG,
EMG, ECG) and they are labeled "V" because MNE reports SI volts after applying
the file calibration; non-voltage channels are never relabeled as volts. MNE
annotations and bad channels are preserved as events.

mne is imported inside the functions below, so importing this module (and the
whole sources package) works without mne installed.
"""

import uuid
from pathlib import Path

import numpy as np

from .base import Chunk, SourceSpec, StreamDescriptor, StreamPlan, register_source

READERS = {
    ".edf": "read_raw_edf",
    ".bdf": "read_raw_bdf",
    ".fif": "read_raw_fif",
    ".vhdr": "read_raw_brainvision",
    ".set": "read_raw_eeglab",
}
FORMATS = tuple(sorted(READERS))
_ARTIFACT_PREFIXES = ("bad", "edge")


def _path(value):
    path = Path(value)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Use a regular local EEG file")
    if path.suffix.lower() not in READERS:
        raise ValueError(
            "Supported recorded files: EDF, BDF, FIF, BrainVision (.vhdr), EEGLAB (.set)"
        )
    return path


def _annotation_events(raw, start_us, rate):
    events = []
    for onset, duration, label in zip(
        raw.annotations.onset, raw.annotations.duration, raw.annotations.description
    ):
        begin = start_us + round((float(onset) - raw.first_time) * 1e6)
        text = str(label)
        events.append(
            {
                "timestamp_us": begin,
                "label": text,
                "category": "artifact"
                if text.lower().startswith(_ARTIFACT_PREFIXES)
                else "annotation",
                "end_us": begin + round(float(duration) * 1e6),
            }
        )
    for channel in raw.info["bads"]:
        events.append(
            {
                "timestamp_us": start_us,
                "label": str(channel),
                "category": "bad_channel",
                "end_us": start_us + round(raw.n_times * 1e6 / rate),
                "channel": str(channel),
            }
        )
    return events


def open(
    path,
    *,
    start_us,
    chunk_samples=1024,
    reference="unspecified",
    clock_domain="unix_us",
    stream_id="eeg",
    modality="eeg",
    units=None,
):
    """Validate options and return an iterator of one recorded-file StreamPlan."""
    file = _path(path)
    if type(start_us) is not int or not 0 <= start_us < 2**63 - 1:
        raise ValueError("start_us must be a nonnegative i64 microsecond timestamp")
    if type(chunk_samples) is not int or not 1 <= chunk_samples <= 1_000_000:
        raise ValueError("chunk_samples must be an integer 1-1000000")
    if not isinstance(reference, str) or not reference:
        raise ValueError("reference must be a nonempty label")
    if units not in (None, "V"):
        raise ValueError("MNE voltage channels are reported in V; do not relabel them")
    return _plans(
        file,
        start_us=start_us,
        chunk_samples=chunk_samples,
        reference=reference,
        clock_domain=clock_domain,
        stream_id=stream_id,
        modality=modality,
    )


def _plans(
    file, *, start_us, chunk_samples, reference, clock_domain, stream_id, modality
):
    import mne  # lazy: the module imports without mne installed

    reader = getattr(mne.io, READERS[file.suffix.lower()])
    raw = reader(str(file), preload=False, verbose="ERROR")
    try:
        picks = mne.pick_types(
            raw.info, eeg=True, eog=True, emg=True, ecg=True, exclude=[]
        )
        if not len(picks):
            raise ValueError(
                "No voltage channels found; non-voltage channels are not relabeled as volts"
            )
        if not 1 <= len(picks) <= 512:
            raise ValueError("Recorded file must contain 1-512 voltage channels")
        channels = [str(raw.ch_names[i]) for i in picks]
        types = [str(raw.get_channel_types()[i]).upper() for i in picks]
        rate = float(raw.info["sfreq"])
        if not np.isfinite(rate) or not 80 <= rate <= 100_000:
            raise ValueError("Recorded sample rate must be 80-100000 Hz")
        if raw.n_times <= 0:
            raise ValueError("Recording contains no samples")
        descriptor = StreamDescriptor(
            channels=channels,
            units=["V"] * len(channels),
            channel_types=types,
            sample_rate_hz=rate,
            reference=reference,
            clock_domain=clock_domain,
            source_clock=None,
            modality=modality,
            provenance={
                "runtime": "mne",
                "reader": READERS[file.suffix.lower()],
                "path": file.name,
                "file_format": file.suffix.lower(),
                "annotations": len(raw.annotations),
                "bad_channels": [str(channel) for channel in raw.info["bads"]],
                "clock_domain": clock_domain,
                "stream_id": stream_id,
            },
        )

        def chunks():
            events = _annotation_events(raw, start_us, rate)
            segment = uuid.uuid4().hex
            first = True
            for offset in range(0, raw.n_times, chunk_samples):
                stop = min(offset + chunk_samples, raw.n_times)
                # Keep the reader's own precision. MNE returns float64 and the stored
                # tensor preserves it; downcasting here would silently round a recording.
                values = np.asarray(raw.get_data(picks=picks, start=offset, stop=stop))
                times = start_us / 1e6 + np.arange(offset, stop) / rate
                yield Chunk(
                    values=values,
                    times=times.astype("<f8"),
                    sample_start=offset,
                    segment_id=segment,
                    events=events if first else [],
                )
                first = False

        yield StreamPlan(descriptor, chunks())
    finally:
        raw.close()


register_source(
    SourceSpec(
        id="mne_file",
        family="recorded file",
        formats=FORMATS,
        description=(
            "Recorded EDF/BDF/FIF/BrainVision/EEGLAB files through explicit MNE "
            "readers; voltage channels only, annotations and bad channels preserved."
        ),
        detect=lambda path: Path(str(path)).suffix.lower() in READERS,
        open=open,
    )
)
