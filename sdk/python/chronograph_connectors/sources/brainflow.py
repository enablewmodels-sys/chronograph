"""Live BrainFlow capture for any board the installed library can describe.

Rows, channel names, sampling rate and modality come from brainflow_catalog,
which is descriptor-driven; the source never guesses a channel layout. The board
owns prepare_session, start_stream, stop_stream and release_session for the whole
lifetime of the plan, including on failure. Samples are read with get_board_data.

Clock and loss honesty is unchanged from bci_acquisition.brainflow_capture:
a timestamp that moves backwards starts a new segment and a gap, a timestamp
discontinuity is a gap, and a package-counter discontinuity is an acquisition
event. A lost-sample count is never invented (lost_samples is always null). The
source clock is BrainFlow's Unix-seconds timestamp, which may be host receipt
time, so the descriptor clock domain is unix_us and it is never relabeled.

PLAYBACK_FILE_BOARD and STREAMING_BOARD are transports: rows and rate are taken
from master_board, and no rate is invented for the transport itself. brainflow is
imported inside the functions, so importing this module needs only numpy.
"""

import math
import time
import uuid

import numpy as np

from .. import brainflow_catalog
from .base import Chunk, SourceSpec, StreamDescriptor, StreamPlan, register_source

TRANSPORT_IDS = tuple(brainflow_catalog.TRANSPORT_IDS)
DISCONTINUITY_PERIODS = 3  # gap when the next timestamp is more than 3/rate away


def _config(values):
    from brainflow.board_shim import BrainFlowInputParams

    config = BrainFlowInputParams()
    for key, value in (values or {}).items():
        if not hasattr(config, key):
            raise ValueError(f"Unknown BrainFlow connection option: {key}")
        setattr(config, key, value)
    return config


def _row_list(value, what):
    if isinstance(value, (str, bytes)) or not hasattr(value, "__len__"):
        raise ValueError(f"{what} must be a list of board row indices")
    rows = [value[index] for index in range(len(value))]
    if not rows or any(
        isinstance(row, bool) or not isinstance(row, int) or row < 0 for row in rows
    ):
        raise ValueError(f"{what} must be nonnegative integer row indices")
    return rows


def open(
    *,
    board_id,
    params=None,
    seconds=30,
    preset=0,
    units=None,
    reference="unspecified",
    master_board=None,
    channel_rows=None,
    channel_names=None,
    sample_rate_hz=None,
    modality=None,
    stream_id=None,
    poll_seconds=0.1,
):
    """Validate the request against the catalog and return one live StreamPlan."""
    if isinstance(board_id, bool) or not isinstance(board_id, int):
        raise ValueError("board_id must be an integer BrainFlow BoardIds value")
    if type(preset) is not int or preset not in brainflow_catalog.PRESET_NAMES:
        raise ValueError("preset must be 0 (default), 1 (auxiliary) or 2 (ancillary)")
    if (
        isinstance(seconds, bool)
        or not isinstance(seconds, (int, float))
        or not 0 < seconds <= 86400
    ):
        raise ValueError("seconds must be 0-86400")
    if (
        isinstance(poll_seconds, bool)
        or not isinstance(poll_seconds, (int, float))
        or not 0 < poll_seconds <= 5
    ):
        raise ValueError("poll_seconds must be a number of seconds within 0-5")
    if not isinstance(reference, str) or not reference:
        raise ValueError("reference must be a nonempty label")
    if master_board is not None and (
        isinstance(master_board, bool) or not isinstance(master_board, int)
    ):
        raise ValueError("master_board must be an integer BoardIds value")
    describe_id = board_id
    if board_id in TRANSPORT_IDS:
        if master_board is None:
            raise ValueError(
                "PLAYBACK_FILE_BOARD and STREAMING_BOARD carry no format of their "
                "own; pass master_board to resolve rows and sampling rate"
            )
        describe_id = master_board
    desc = brainflow_catalog.describe(describe_id, preset)
    if not desc["describable"]:
        raise ValueError(
            f"BrainFlow board {describe_id} does not describe a sampling rate and "
            "row count; it cannot be captured as a signal source"
        )
    rows = (
        _row_list(channel_rows, "channel_rows")
        if channel_rows is not None
        else list(desc["primary_rows"])
    )
    if rows and desc["num_rows"] is not None and max(rows) >= desc["num_rows"]:
        raise ValueError("channel_rows exceed the descriptor row count")
    names = (
        list(channel_names) if channel_names is not None else list(desc["channel_names"])
    )
    if len(names) != len(rows) or len(set(names)) != len(names):
        raise ValueError("Provide one unique channel name per selected board row")
    if any(not isinstance(name, str) or not name for name in names):
        raise ValueError("Channel names must be nonempty strings")
    kind = str(modality or desc["modality"] or "eeg")
    rate = float(sample_rate_hz if sample_rate_hz is not None else desc["sampling_rate"])
    if not math.isfinite(rate) or not 0 < rate <= 100_000:
        raise ValueError("BrainFlow sampling rate must be finite and within 0-100000 Hz")
    if units is None:
        raise ValueError(
            "Specify the original board units explicitly, for example uV"
        )
    if isinstance(units, (str, bytes)):
        unit_list = [str(units)] * len(rows)
    else:
        unit_list = list(units)
    if len(unit_list) != len(rows) or any(
        not isinstance(unit, str) or not unit for unit in unit_list
    ):
        raise ValueError("Provide one explicit unit per selected board row")
    config = _config(params)
    if master_board is not None and not (params or {}).get("master_board"):
        config.master_board = master_board
    return _plans(
        board_id=board_id,
        preset=preset,
        config=config,
        rows=rows,
        names=names,
        units=unit_list,
        rate=rate,
        seconds=seconds,
        poll_seconds=poll_seconds,
        kind=kind,
        reference=reference,
        stream_id=stream_id or kind,
        desc=desc,
        describe_id=describe_id,
    )


def _plans(
    *,
    board_id,
    preset,
    config,
    rows,
    names,
    units,
    rate,
    seconds,
    poll_seconds,
    kind,
    reference,
    stream_id,
    desc,
    describe_id,
):
    from brainflow.board_shim import BoardShim

    timestamp_row = desc["timestamp_channel"]
    if timestamp_row is None:
        raise ValueError(
            "This board exposes no timestamp channel, so samples cannot be written "
            "with their original source clock"
        )
    descriptor = StreamDescriptor(
        channels=names,
        units=units,
        channel_types=[kind.upper()] * len(rows),
        sample_rate_hz=rate,
        reference=reference,
        clock_domain="unix_us",
        source_clock="BrainFlow Unix seconds (may be host receipt time)",
        modality=kind,
        provenance={
            "runtime": "brainflow",
            "board_id": board_id,
            "master_board": describe_id,
            "preset": preset,
            "preset_name": desc["preset_name"],
            "board_name": desc["board_name"],
            "device_name": desc["device_name"],
            "vendor": desc["vendor"],
            "rows": list(rows),
            "clock_domain": "unix_us",
            "stream_id": stream_id,
        },
    )
    board = BoardShim(board_id, config)
    board.prepare_session()
    started = False
    try:
        board.start_stream(max(45000, round(rate * 60)))
        started = True
        yield StreamPlan(
            descriptor,
            _chunks(
                board,
                preset=preset,
                rows=rows,
                rate=rate,
                seconds=seconds,
                poll_seconds=poll_seconds,
                timestamp_row=timestamp_row,
                package_row=desc["package_num_channel"],
                marker_row=desc["marker_channel"],
            ),
        )
    finally:
        try:
            if started:
                board.stop_stream()
        finally:
            board.release_session()


def _chunks(
    board,
    *,
    preset,
    rows,
    rate,
    seconds,
    poll_seconds,
    timestamp_row,
    package_row,
    marker_row,
):
    segment = uuid.uuid4().hex
    offset = 0
    previous_time = None
    last_package = None
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        data = board.get_board_data(preset=preset)
        if data.shape[1]:
            times = np.asarray(data[timestamp_row], dtype="<f8")
            gaps, events = [], []
            if previous_time is not None and times[0] < previous_time:
                gaps.append(
                    {
                        "start_us": round(times[0] * 1e6),
                        "end_us": round(previous_time * 1e6),
                        "reason": "Clock moved backwards; new segment",
                        "lost_samples": None,
                    }
                )
                segment = uuid.uuid4().hex
                offset = 0
            if (
                previous_time is not None
                and times[0] - previous_time > DISCONTINUITY_PERIODS / rate
            ):
                gaps.append(
                    {
                        "start_us": round((previous_time + 1 / rate) * 1e6),
                        "end_us": round(times[0] * 1e6),
                        "reason": (
                            "Timestamp discontinuity; hardware loss count unknown"
                        ),
                        "lost_samples": None,
                    }
                )
            # Package counters can wrap with board-specific widths. Preserve them
            # and report discontinuities without guessing a lost count.
            counters = (
                np.asarray(data[package_row], dtype="<f8")
                if package_row is not None
                else None
            )
            if (
                counters is not None
                and last_package is not None
                and counters[0] != last_package + 1
            ):
                events.append(
                    {
                        "timestamp_us": round(times[0] * 1e6),
                        "label": "Package counter discontinuity",
                        "category": "acquisition",
                        "previous": float(last_package),
                        "current": float(counters[0]),
                    }
                )
            if counters is not None:
                last_package = float(counters[-1])
            auxiliary = {}
            if counters is not None:
                auxiliary["package_counters"] = counters
            if marker_row is not None:
                auxiliary["markers"] = np.asarray(data[marker_row], dtype="<f8")
            if counters is not None:
                events.append(
                    {
                        "timestamp_us": round(times[0] * 1e6),
                        "label": "Board package range",
                        "category": "acquisition",
                        "first": float(counters[0]),
                        "last": float(counters[-1]),
                        "preset": preset,
                    }
                )
            if marker_row is not None:
                markers = data[marker_row]
                for index in np.flatnonzero(markers):
                    events.append(
                        {
                            "timestamp_us": round(times[index] * 1e6),
                            "label": str(markers[index]),
                            "category": "marker",
                        }
                    )
            chunk = Chunk(
                values=np.ascontiguousarray(np.asarray(data[rows], dtype="<f4")),
                times=times,
                sample_start=offset,
                segment_id=segment,
                auxiliary=auxiliary,
                events=events,
                gaps=gaps,
            )
            offset += len(times)
            previous_time = times[-1]
            yield chunk
        time.sleep(poll_seconds)


register_source(
    SourceSpec(
        id="brainflow",
        family="live board",
        formats=("board",),
        description=(
            "Live capture from any BrainFlow board or transport, with rows, rate "
            "and modality resolved from the descriptor-driven catalog."
        ),
        detect=lambda path: False,
        open=open,
    )
)
