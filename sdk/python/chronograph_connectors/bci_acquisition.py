"""Local acquisition only. Device configuration and control stay outside ChronoDB."""

import time
import uuid
import numpy as np


def synthetic(
    session,
    *,
    seconds=30,
    rate=250,
    channels=8,
    start_us=0,
    realtime=False,
    seed=42,
    channel_names=None,
):
    if (
        not 1 <= channels <= 512
        or not 80 <= rate <= 100_000
        or not 0 < seconds <= 86400
    ):
        raise ValueError("Invalid synthetic recording bounds")
    session.stream(
        "eeg",
        channels=channel_names or [f"EEG{i + 1:02d}" for i in range(channels)],
        units=["V"] * channels,
        sample_rate_hz=rate,
        reference="synthetic reference",
    )
    step = max(1, rate // 4)
    segment = uuid.uuid4().hex
    rng = np.random.default_rng(seed)
    began = time.monotonic()
    for offset in range(0, round(seconds * rate), step):
        count = min(step, round(seconds * rate) - offset)
        index = np.arange(offset, offset + count)
        t = index / rate
        side = (index // (4 * rate)) % 2
        signal = rng.normal(0, 2e-6, (channels, count))
        for c in range(channels):
            amp = np.where(side == c % 2, 12e-6, 3e-6)
            signal[c] += amp * np.sin(2 * np.pi * (10 + (c // 2)) * t) + 1e-6 * np.sin(
                2 * np.pi * 22 * t
            )
        session.signal(
            "eeg",
            signal.astype("<f4"),
            start_us / 1e6 + t,
            sample_start=offset,
            segment_id=segment,
        )
        for event in index[index % (4 * rate) == 0]:
            session.event(
                "eeg",
                start_us + round(int(event) * 1e6 / rate),
                "left" if (event // (4 * rate)) % 2 == 0 else "right",
                category="cue",
                synthetic=True,
            )
        if realtime:
            time.sleep(max(0, began + (offset + count) / rate - time.monotonic()))


def recorded_file(
    session, path, *, start_us, chunk_samples=1024, reference="unspecified"
):
    import mne
    from pathlib import Path

    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Use a regular local EEG file")
    readers = {
        ".edf": mne.io.read_raw_edf,
        ".bdf": mne.io.read_raw_bdf,
        ".fif": mne.io.read_raw_fif,
    }
    if path.suffix.lower() not in readers:
        raise ValueError("Supported recorded files: EDF/BDF/FIF")
    raw = readers[path.suffix.lower()](path, preload=False, verbose="ERROR")
    try:
        picks = mne.pick_types(
            raw.info, eeg=True, eog=True, emg=True, ecg=True, exclude=[]
        )
        if not len(picks):
            raise ValueError(
                "No voltage channels found; non-voltage channels are not relabeled as volts"
            )
        channels = [raw.ch_names[i] for i in picks]
        types = [raw.get_channel_types()[i].upper() for i in picks]
        rate = float(raw.info["sfreq"])
        session.stream(
            "eeg",
            channels=channels,
            units=["V"] * len(picks),
            channel_types=types,
            sample_rate_hz=rate,
            reference=reference,
        )
        segment = uuid.uuid4().hex
        for offset in range(0, raw.n_times, chunk_samples):
            stop = min(offset + chunk_samples, raw.n_times)
            session.signal(
                "eeg",
                raw.get_data(picks=picks, start=offset, stop=stop),
                start_us / 1e6 + np.arange(offset, stop) / rate,
                sample_start=offset,
                segment_id=segment,
            )
        # Preserve durations and BAD annotations (events_from_annotations excludes
        # those by default). MNE annotation onsets include raw.first_time.
        for onset, duration, label in zip(
            raw.annotations.onset, raw.annotations.duration, raw.annotations.description
        ):
            begin = start_us + round((float(onset) - raw.first_time) * 1e6)
            session.event(
                "eeg",
                begin,
                str(label),
                category="artifact"
                if str(label).lower().startswith(("bad", "edge"))
                else "annotation",
                end_us=begin + round(float(duration) * 1e6),
            )
        for ch in raw.info["bads"]:
            session.event(
                "eeg",
                start_us,
                ch,
                category="bad_channel",
                end_us=start_us + round(raw.n_times * 1e6 / rate),
                channel=ch,
            )
    finally:
        raw.close()


def brainflow_capture(
    session,
    *,
    board_id,
    params,
    seconds=30,
    preset=0,
    units=None,
    reference="unspecified",
):
    from brainflow.board_shim import BoardShim, BrainFlowInputParams

    config = BrainFlowInputParams()
    for key, value in params.items():
        if not hasattr(config, key):
            raise ValueError(f"Unknown BrainFlow connection option: {key}")
        setattr(config, key, value)
    board = BoardShim(board_id, config)
    indices = BoardShim.get_eeg_channels(board_id, preset)
    rate = BoardShim.get_sampling_rate(board_id, preset)
    names = BoardShim.get_eeg_names(board_id, preset)
    if not names:
        names = [f"EEG{i + 1}" for i in range(len(indices))]
    if units is None:
        raise ValueError("Specify the original board units explicitly, for example uV")
    session.stream(
        "eeg",
        channels=names,
        units=[units] * len(indices),
        sample_rate_hz=rate,
        reference=reference,
        source_clock="BrainFlow Unix seconds (may be host receipt time)",
    )
    segment = uuid.uuid4().hex
    offset = 0
    previous_time = None
    last_package = None
    marker_row = BoardShim.get_marker_channel(board_id, preset)
    package_row = BoardShim.get_package_num_channel(board_id, preset)
    board.prepare_session()
    try:
        board.start_stream(max(45000, rate * 60))
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            data = board.get_board_data(preset=preset)
            if data.shape[1]:
                ts = data[BoardShim.get_timestamp_channel(board_id, preset)]
                if previous_time is not None and ts[0] < previous_time:
                    session.gap(
                        "eeg",
                        round(ts[0] * 1e6),
                        round(previous_time * 1e6),
                        reason="Clock moved backwards; new segment",
                        lost_samples=None,
                    )
                    segment = uuid.uuid4().hex
                    offset = 0
                if previous_time is not None and ts[0] - previous_time > 3 / rate:
                    session.gap(
                        "eeg",
                        round((previous_time + 1 / rate) * 1e6),
                        round(ts[0] * 1e6),
                        reason="Timestamp discontinuity; hardware loss count unknown",
                    )
                # Package counters can wrap with board-specific widths. Preserve
                # them and report discontinuities without guessing a lost count.
                counters = data[package_row]
                if last_package is not None and counters[0] != last_package + 1:
                    session.event(
                        "eeg",
                        round(ts[0] * 1e6),
                        "Package counter discontinuity",
                        category="acquisition",
                        previous=float(last_package),
                        current=float(counters[0]),
                    )
                last_package = counters[-1]
                session.signal(
                    "eeg",
                    data[indices],
                    ts,
                    sample_start=offset,
                    segment_id=segment,
                    auxiliary={
                        "package_counters": counters,
                        "markers": data[marker_row],
                    },
                )
                session.event(
                    "eeg",
                    round(ts[0] * 1e6),
                    "Board package range",
                    category="acquisition",
                    first=float(counters[0]),
                    last=float(counters[-1]),
                    preset=preset,
                )
                for i in np.flatnonzero(data[marker_row]):
                    session.event(
                        "eeg",
                        round(ts[i] * 1e6),
                        str(data[marker_row, i]),
                        category="marker",
                    )
                offset += len(ts)
                previous_time = ts[-1]
            time.sleep(0.1)
    finally:
        try:
            board.stop_stream()
        finally:
            board.release_session()


def lsl_capture(
    session,
    *,
    source_id,
    channels,
    units,
    seconds=30,
    expected_rate=None,
    reference="unspecified",
):
    from pylsl import StreamInlet, resolve_byprop, local_clock
    from pylsl.util import LostError, TimeoutError

    if session.clock != "lsl_local_us":
        raise ValueError("LSL capture requires lsl_local_us binding")
    until = time.monotonic() + seconds
    last = None
    while time.monotonic() < until:
        streams = resolve_byprop(
            "source_id", source_id, timeout=min(2, max(0.01, until - time.monotonic()))
        )
        if len(streams) != 1:
            if len(streams) > 1:
                raise ValueError("LSL source_id is ambiguous")
            continue
        info = streams[0]
        rate = info.nominal_srate()
        if (
            rate <= 0
            or info.channel_count() != len(channels)
            or (expected_rate is not None and rate != expected_rate)
        ):
            raise ValueError("LSL channel count/rate mismatch")
        session.stream(
            "eeg",
            channels=channels,
            units=units,
            sample_rate_hz=rate,
            source_clock=source_id,
            reference=reference,
        )
        inlet = StreamInlet(info, max_buflen=60, recover=False, processing_flags=0)
        segment = uuid.uuid4().hex
        offset = 0
        try:
            while time.monotonic() < until:
                correction = inlet.time_correction(timeout=2)
                session.clock_measurement(
                    "eeg",
                    round(local_clock() * 1e6),
                    correction,
                    source_clock=source_id,
                )
                samples, times = inlet.pull_chunk(
                    timeout=0.5, max_samples=max(1, round(rate / 4))
                )
                if not times:
                    continue
                first = (times[0] + correction) * 1e6
                if last is not None and first - last > 3e6 / rate:
                    session.gap(
                        "eeg",
                        round(last + 1e6 / rate),
                        round(first),
                        reason="LSL interruption; loss count unknown",
                    )
                session.signal(
                    "eeg",
                    np.asarray(samples, dtype="<f4").T,
                    times,
                    sample_start=offset,
                    segment_id=segment,
                    correction_seconds=correction,
                )
                offset += len(times)
                last = (times[-1] + correction) * 1e6
        except (LostError, TimeoutError):
            session.event(
                "eeg",
                round(local_clock() * 1e6),
                "LSL reconnecting",
                category="acquisition",
            )
        finally:
            inlet.close_stream()
