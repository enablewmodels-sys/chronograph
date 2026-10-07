"""Spec-driven encoder registry and BrainFlow catalog evidence. No hardware.

Runs the sources registry and the BrainFlow catalog against the really installed
installed BrainFlow driver, mne and pylsl, with no physical board attached and no
physical-board claim: the only boards used are the BrainFlow synthetic board and
BrainFlow's own file/multicast transports. Exits non-zero on any failed check and
prints one evidence line per assertion group.
"""

import json
import os
import shutil
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
# The console ships a catalogue snapshot generated from one driver version. Checking
# the installed driver against that snapshot is what catches drift, so the counts here
# are read from the artefact users actually get rather than repeated as literals.
SNAPSHOT = json.loads(
    (ROOT / "ui" / "src" / "brainflow-boards.json").read_text(encoding="utf-8")
)
PACKAGE = ROOT / "sdk" / "python"
if str(PACKAGE) not in sys.path:
    sys.path.insert(0, str(PACKAGE))

import chronograph_connectors
from chronograph_connectors import brainflow_catalog as catalog
from chronograph_connectors import sources
from chronograph_connectors.bci import Session
from chronograph_connectors.bci_spool import BCISpool

CHECKS = 0
TMP = Path(tempfile.mkdtemp(prefix="chronodb-formats-"))
RATE = 250
CHANNELS = 8
SAMPLES = 750
NAMES = [f"EEG{i:03d}" for i in range(1, CHANNELS + 1)]


def require(condition, message):
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(message)
    return True


def line(*parts):
    print(" ".join(str(part) for part in parts), flush=True)


def sample_data(seed=11):
    rng = np.random.default_rng(seed)
    index = np.arange(SAMPLES)
    data = rng.normal(0, 2e-6, (CHANNELS, SAMPLES))
    for channel in range(CHANNELS):
        data[channel] += 12e-6 * np.sin(2 * np.pi * (10 + channel) * index / RATE)
    return data.astype("<f8")


@contextmanager
def recording(name, clock_domain="unix_us"):
    directory = TMP / name
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with BCISpool(str(directory), "formats_test", name) as pool:
        yield pool, Session(pool, name=f"{name} recording", source=name, clock_domain=clock_domain)


def queued_records(pool):
    records = []
    for (body,) in pool.db.execute("SELECT body FROM queue ORDER BY sequence"):
        records.extend(json.loads(body)["records"])
    return records


def asset_tensor(pool, key):
    meta, data = pool.db.execute(
        "SELECT metadata, data FROM asset WHERE id=?", (key,)
    ).fetchone()
    meta = json.loads(meta)
    dtype = {"f32": "<f4", "f64": "<f8"}[meta["dtype"]]
    return np.frombuffer(data, dtype=dtype).reshape(meta["shape"])


def types_of(records):
    return {record["fields"]["type"] for record in records}


def read_source(source_id, **options):
    spec = sources.source(source_id)
    plans = list(spec.open(**options))
    descriptors = [plan.descriptor for plan in plans]
    chunks = [chunk for plan in plans for chunk in plan.chunks]
    return descriptors, chunks


# --------------------------------------------------------------------------- 1
def check_capabilities():
    from importlib.metadata import version

    caps = catalog.capabilities()
    line(
        f"capabilities brainflow={caps['brainflow_version']} "
        f"installed={version('brainflow')} board_ids={caps['board_ids']} "
        f"described={caps['described']} undescribed={caps['undescribed']} "
        f"vendors={caps['vendors']} transports={caps['transports']}"
    )
    require(caps["brainflow_version"] == version("brainflow"), "version mismatch")
    require(caps["board_ids"] >= 60, "expected at least 60 board ids")
    require(
        caps["brainflow_version"] == SNAPSHOT["brainflow_version"],
        "the shipped catalogue must be regenerated for the installed driver",
    )
    require(
        caps["board_ids"] == SNAPSHOT["counts"]["boards"],
        "device ids must match the shipped catalogue",
    )
    require(caps["described"] == caps["board_ids"], "every device must be describable")
    require(caps["undescribed"] == [], "no undescribed devices expected")
    require(caps["vendors"] == 18, "18 documented vendors")
    require(caps["transports"] == ["NO_BOARD", "PLAYBACK_FILE_BOARD", "STREAMING_BOARD"], "3 transports")
    return caps


# --------------------------------------------------------------------------- 2
def check_every_board():
    from brainflow.board_shim import BoardIds, BoardShim

    members = sorted(
        (name for name in dir(BoardIds) if name.isupper()),
        key=lambda name: int(getattr(BoardIds, name)),
    )
    expected_members = SNAPSHOT["counts"]["boards"] + SNAPSHOT["counts"]["transports"]
    require(
        len(members) == expected_members,
        f"{expected_members} BoardIds members expected, saw {len(members)}",
    )
    described, transports = 0, 0
    for name in members:
        board_id = int(getattr(BoardIds, name))
        info = catalog.describe(board_id)
        for key in (
            "board_id",
            "board_name",
            "device_name",
            "vendor",
            "preset",
            "preset_name",
            "sampling_rate",
            "num_rows",
            "rows",
            "primary_rows",
            "channel_names",
            "modality",
            "timestamp_channel",
            "package_num_channel",
            "marker_channel",
            "battery_channel",
            "describable",
        ):
            require(key in info, f"{name} describe() is missing {key}")
        require(info["board_id"] == board_id, f"{name} id mismatch")
        require(info["board_name"] == name, f"{name} board_name mismatch")
        if info["transport"]:
            transports += 1
            require(info["sampling_rate"] is None, f"{name} must not invent a rate")
            require(not info["describable"], f"{name} must not be describable")
        else:
            described += 1
            require(info["describable"], f"{name} must be describable")
            require(
                isinstance(info["sampling_rate"], (int, float))
                and info["sampling_rate"] > 0,
                f"{name} needs a real sampling rate",
            )
            require(
                isinstance(info["num_rows"], int) and info["num_rows"] > 0,
                f"{name} needs a real row count",
            )
            require(info["rows"] and info["primary_rows"], f"{name} has no rows")
            require(
                len(info["channel_names"]) == len(info["primary_rows"]),
                f"{name} channel name count",
            )
            require(info["device_name"], f"{name} needs a device name")
            require(info["modality"] != "eeg" or "eeg" in info["rows"], f"{name} modality")
            require(
                max(info["primary_rows"]) < info["num_rows"],
                f"{name} primary rows exceed num_rows",
            )
            require(
                all(
                    0 <= row < info["num_rows"]
                    for group in info["rows"].values()
                    for row in group
                ),
                f"{name} row index out of range",
            )
            presets = catalog.presets(board_id)
            require(presets, f"{name} must expose at least one preset")
            by_preset = {entry["preset"]: entry for entry in presets}
            require(
                0 in by_preset and by_preset[0]["describable"],
                f"{name} default preset must be describable",
            )
        line(
            f"board {name} id={board_id} vendor={info['vendor']!r} "
            f"modality={info['modality']} rate={info['sampling_rate']} "
            f"rows={info['num_rows']} primary={len(info['primary_rows'])} "
            f"names={info['channel_names'][:3]} describable={info['describable']}"
        )
    require(
        described == SNAPSHOT["counts"]["boards"]
        and transports == SNAPSHOT["counts"]["transports"],
        "described devices and transports must match the shipped catalogue",
    )

    # The shipped snapshot is the file the console and the SDK both read, so it must
    # agree with this driver in every dimension a user can see. Comparing only the board
    # count let a catalogue with permuted vendors or invented presets pass, which is how
    # 28 undocumented boards stayed hidden from the picker while this suite was green.
    live = catalog.catalog()
    live_boards = live["boards"]
    shipped = {board["name"]: board for board in SNAPSHOT["boards"]}
    require(
        sorted(shipped) == sorted(live_boards),
        "the shipped catalogue must name exactly the boards this driver defines",
    )
    for name, entry in sorted(live_boards.items()):
        snapshot = shipped[name]
        presets = catalog.presets(entry["board_id"]) or [entry]
        expected_presets = [
            {
                "preset": item["preset"],
                "name": item["preset_name"],
                "device": item["device_name"],
                "rate": item["sampling_rate"],
                "channels": len(item["primary_rows"]),
                "modality": item["modality"],
            }
            for item in presets
        ]
        for field, value in (
            ("id", entry["board_id"]),
            ("device", entry["device_name"]),
            ("vendor", entry["vendor"]),
            ("rate", entry["sampling_rate"]),
            ("channels", len(entry["primary_rows"])),
            ("modality", entry["modality"]),
            ("describable", entry.get("describable", True)),
            ("channel_names", [str(item) for item in entry["channel_names"]][:24]),
            ("presets", expected_presets),
        ):
            require(
                snapshot.get(field) == value,
                f"{name}.{field}: shipped={snapshot.get(field)!r} driver={value!r}",
            )
    for field in ("counts", "vendors"):
        require(
            SNAPSHOT[field] == live[field],
            f"the shipped catalogue's {field} differs from the driver",
        )
    # The driver reports transports as a map of names to descriptors; the catalogue
    # ships the sorted names.
    require(
        sorted(SNAPSHOT["transports"]) == sorted(live["transports"]),
        "the shipped catalogue's transports differ from the driver",
    )
    require(
        sorted(SNAPSHOT["undocumented"]) == sorted(live["undocumented_boards"]),
        "the shipped catalogue's undocumented set differs from the driver",
    )
    # A board the driver defines but the vendor table omits reaches the console as the
    # placeholder group, which is how 28 real devices were hidden behind one name. The
    # table now covers every member the driver constructs, so the placeholder is empty
    # and a driver upgrade that adds a member fails here instead of in the picker.
    require(
        not live["undocumented_boards"],
        "every board this driver defines must belong to a vendor, but "
        + ", ".join(live["undocumented_boards"])
        + " have none",
    )
    line(
        f"snapshot boards={len(shipped)} vendors={len(SNAPSHOT['vendors'])} "
        "presets=" + str(sum(len(board["presets"]) for board in SNAPSHOT["boards"]))
        + " matches the installed driver in name, vendor, geometry, channels and presets"
    )

    # The six boards whose eeg convenience accessors raise must still describe.
    accessor_gap = (
        "CALLIBRI_EMG_BOARD",
        "CALLIBRI_ECG_BOARD",
        "GFORCE_PRO_BOARD",
        "GFORCE_DUAL_BOARD",
        "ANT_NEURO_EE_410_BOARD",
        "EMOTIBIT_BOARD",
    )
    for name in accessor_gap:
        board_id = int(getattr(BoardIds, name))
        try:
            BoardShim.get_eeg_channels(board_id)
            raised = False
        except Exception:
            raised = True
        info = catalog.describe(board_id)
        require(info["describable"], f"{name} must describe despite the accessor gap")
        require(info["device_name"] and info["sampling_rate"], f"{name} descriptor facts")
        line(
            f"accessor-gap {name} get_eeg_channels_raises={raised} "
            f"device={info['device_name']!r} modality={info['modality']} "
            f"rate={info['sampling_rate']} rows={info['num_rows']}"
        )
    try:
        catalog.describe(999999)
        invented = False
    except ValueError:
        invented = True
    require(invented, "describe must reject an unknown board id")
    require(
        len(catalog.catalog()["boards"]) == SNAPSHOT["counts"]["boards"],
        "catalog board count",
    )


# --------------------------------------------------------------------------- 3
def check_modality_groups():
    from brainflow.board_shim import BoardIds

    emotibit = catalog.describe(int(BoardIds.EMOTIBIT_BOARD))
    gforce = catalog.describe(int(BoardIds.GFORCE_PRO_BOARD))
    require(emotibit["modality"] != "eeg" and not emotibit["rows"].get("eeg"), "EmotiBit eeg")
    require(gforce["modality"] == "emg" and not gforce["rows"].get("eeg"), "gForcePro eeg")
    presets = {entry["preset"]: entry for entry in catalog.presets(int(BoardIds.EMOTIBIT_BOARD))}
    require(presets[1]["modality"] == "ppg", "EmotiBit auxiliary preset is PPG")
    require(presets[2]["modality"] == "eda", "EmotiBit ancillary preset is EDA")
    line(
        f"modality EmotiBit default={emotibit['modality']} "
        f"presets={{"
        + ", ".join(f"{key}:{presets[key]['modality']}" for key in sorted(presets))
        + f"}} gForcePro={gforce['modality']}"
    )
    line(
        "modality-groups "
        + ", ".join(
            f"{name}:{catalog.describe(int(getattr(BoardIds, name)))['modality']}"
            for name in (
                "CALLIBRI_EMG_BOARD",
                "CALLIBRI_ECG_BOARD",
                "GFORCE_DUAL_BOARD",
                "ANT_NEURO_EE_410_BOARD",
            )
        )
    )


# --------------------------------------------------------------------------- 4
def check_transports_classification():
    report = catalog.catalog()
    for name, board_id in catalog.TRANSPORTS.items():
        require(name in report["transports"], f"{name} must be a transport")
        require(name not in report["boards"], f"{name} must not be a device")
        info = report["transports"][name]
        require(info["board_id"] == board_id, f"{name} id")
        require(info["sampling_rate"] is None, f"{name} rate must be None")
        require(not info["describable"], f"{name} must not be describable")
        require(info["transport"], f"{name} transport flag")
    require(
        len(report["boards"]) + len(report["transports"])
        == SNAPSHOT["counts"]["boards"] + SNAPSHOT["counts"]["transports"],
        "every member is either a board or a transport",
    )
    line(
        "transports "
        + ", ".join(
            f"{name}={info['board_id']}(describable={info['describable']})"
            for name, info in sorted(report["transports"].items())
        )
        + f" devices={len(report['boards'])}"
    )


# --------------------------------------------------------------------------- 5
def check_shimmer_and_fabrication():
    from brainflow.board_shim import BoardIds, BoardShim

    missing = catalog.missing_documented()
    report = catalog.catalog()
    # The catalogue may only call a vendor unavailable when the installed driver
    # really has none of its members, and it may never name a device the driver
    # does provide. On 5.22.2 that set was Shimmer alone; upgrading the driver has
    # to shrink the set rather than leave a stale claim in place.
    unavailable = report["unavailable_vendors"]
    require(
        missing == sorted(unavailable),
        f"missing_documented()={missing} must equal unavailable_vendors={sorted(unavailable)}",
    )
    declared = sorted(name for members in unavailable.values() for name in members)
    present = [name for name in declared if hasattr(BoardIds, name)]
    require(not present, f"unavailable_vendors names devices the driver has: {present}")
    device_text = json.dumps(
        {"boards": report["boards"], "transports": report["transports"]}, sort_keys=True
    )
    for name in declared:
        require(name not in device_text, f"{name} must not appear as a device")
    require(
        all(
            isinstance(member, str)
            for members in unavailable.values()
            for member in members
        ),
        "an unavailable vendor is reported by documented name only, never by an id or rate",
    )
    for vendor in unavailable:
        require(
            not any(info["vendor"] == vendor for info in report["boards"].values()),
            f"no device may claim the unavailable {vendor} vendor",
        )
    for name, info in report["boards"].items():
        require(
            info["board_id"] == int(getattr(BoardIds, name)),
            f"{name} id must come from the installed enum",
        )
        if info["describable"]:
            try:
                value = BoardShim.get_sampling_rate(info["board_id"], info["preset"])
            except Exception:
                value = None
            if value is not None:
                require(
                    float(value) == float(info["sampling_rate"]),
                    f"{name} rate must match the library",
                )
        else:
            require(info["sampling_rate"] is None, f"{name} invented rate")
    line(
        f"truth missing_documented={missing} unavailable_vendors={report['unavailable_vendors']} "
        f"shimmer_member={hasattr(BoardIds, 'SHIMMER3_BOARD')} "
        f"undocumented_boards={report['undocumented_boards']}"
    )


# --------------------------------------------------------------------------- 6
def check_brainflow_transports():
    from brainflow.board_shim import (
        BoardIds,
        BoardShim,
        BrainFlowInputParams,
        BrainFlowPresets,
    )

    options = catalog.transport_options()
    for key in ("live_board", "playback_file", "streaming_board", "streamer_output", "presets"):
        require(key in options, f"transport_options must document {key}")
    require(
        options["playback_file"]["board_id"] == int(BoardIds.PLAYBACK_FILE_BOARD),
        "playback board id",
    )
    require(
        options["streaming_board"]["board_id"] == int(BoardIds.STREAMING_BOARD),
        "streaming board id",
    )
    require(
        [entry["value"] for entry in options["presets"]] == [0, 1, 2], "preset values"
    )
    require(":w" in options["streamer_output"]["api"], "streamer modes documented")
    line(f"transport-options keys={sorted(options)} presets={options['presets']}")

    verified = []

    # a) synthetic board, live capture through the generic writer
    with recording("synthetic") as (pool, session):
        delivered = []
        session.on_signal = lambda stream, values, times: delivered.append(len(times))
        summary = sources.run_source(
            session, "brainflow", board_id=int(BoardIds.SYNTHETIC_BOARD), params={},
            seconds=1.5, units="uV",
        )
        require(summary["chunks"] >= 1 and summary["samples"] > 100, "synthetic samples")
        require(
            len(delivered) == summary["chunks"],
            "on_signal must fire exactly once per chunk",
        )
        require(sum(delivered) == summary["samples"], "on_signal sample total")
        records = queued_records(pool)
        kinds = types_of(records)
        require({"session", "stream", "signal"} <= kinds, f"synthetic records {kinds}")
        streams = [r for r in records if r["fields"]["type"] == "stream"]
        require(
            streams[0]["fields"]["sample_rate_hz"] == 250
            and len(streams[0]["fields"]["channels"]) == 16
            and streams[0]["fields"]["source_clock"]
            == "BrainFlow Unix seconds (may be host receipt time)",
            "stream metadata must come from the descriptor",
        )
        require(
            streams[0]["fields"]["units"] == ["uV"] * 16,
            "units must be the explicitly requested ones",
        )
        signals = [r for r in records if r["fields"]["type"] == "signal"]
        first = signals[0]
        require(
            "package_counters" in first["assets"] and "markers" in first["assets"],
            "auxiliary package counters and markers must be stored",
        )
        tensor = asset_tensor(pool, first["assets"]["signal"])
        require(tensor.shape[0] == 16 and np.isfinite(tensor).all(), "synthetic tensor")
        total = sum(int(r["fields"]["sample_count"]) for r in signals)
        require(total == summary["samples"], "sample count must match the records")
        events = [r for r in records if r["fields"]["type"] == "event"]
        require(
            any(r["fields"]["category"] == "acquisition" for r in events),
            "board package-range acquisition event expected",
        )
        line(
            f"transport synthetic-board chunks={summary['chunks']} samples={summary['samples']} "
            f"channels={tensor.shape[0]} rate={streams[0]['fields']['sample_rate_hz']} "
            f"events={len(events)} clocks={summary['clocks']} gaps={summary['gaps']}"
        )
    verified.append("synthetic_live_board")

    # b) streamer file written by BrainFlow, read back by the playback transport
    stream_path = TMP / "stream_default.csv"
    producer = BoardShim(int(BoardIds.SYNTHETIC_BOARD), BrainFlowInputParams())
    producer.prepare_session()
    try:
        producer.add_streamer(
            "file://" + str(stream_path) + ":w", BrainFlowPresets.DEFAULT_PRESET
        )
        producer.start_stream(45000)
        time.sleep(1.5)
    finally:
        try:
            producer.stop_stream()
        finally:
            producer.release_session()
    require(stream_path.is_file() and stream_path.stat().st_size > 0, "streamer file")
    with recording("playback") as (pool, session):
        summary = sources.run_source(
            session, "brainflow", board_id=int(BoardIds.PLAYBACK_FILE_BOARD),
            master_board=int(BoardIds.SYNTHETIC_BOARD),
            params={"file": str(stream_path)}, seconds=1.0, units="uV",
        )
        require(summary["samples"] > 100, "playback samples")
        records = queued_records(pool)
        stream = next(r for r in records if r["fields"]["type"] == "stream")
        require(
            stream["fields"]["sample_rate_hz"] == 250
            and len(stream["fields"]["channels"]) == 16,
            "playback must resolve master_board rows and rate",
        )
        line(
            f"transport playback-file bytes={stream_path.stat().st_size} "
            f"chunks={summary['chunks']} samples={summary['samples']} "
            f"channels={len(stream['fields']['channels'])} rate={stream['fields']['sample_rate_hz']}"
        )
    verified.append("playback_file")

    # c) streaming board over multicast, producer and consumer in this process
    address, port = "239.10.10.10", 6689
    streamed = None
    for candidate in (6689, 6690, 6691):
        port = candidate
        producer = BoardShim(int(BoardIds.SYNTHETIC_BOARD), BrainFlowInputParams())
        producer.prepare_session()
        try:
            producer.add_streamer(
                f"streaming_board://{address}:{port}", BrainFlowPresets.DEFAULT_PRESET
            )
            producer.start_stream(45000)
            try:
                with recording(f"streaming{port}") as (pool, session):
                    summary = sources.run_source(
                        session, "brainflow",
                        board_id=int(BoardIds.STREAMING_BOARD),
                        master_board=int(BoardIds.SYNTHETIC_BOARD),
                        params={"ip_address": address, "ip_port": port},
                        seconds=2.0, units="uV",
                    )
                    records = queued_records(pool)
                    stream = [r for r in records if r["fields"]["type"] == "stream"]
                    streamed = (port, summary, stream[0] if stream else None)
            except Exception as error:
                line(f"streaming retry port={port} error={type(error).__name__}: {error}")
            finally:
                producer.stop_stream()
        finally:
            producer.release_session()
        if streamed and streamed[1]["samples"] > 100:
            break
        streamed = None
    require(streamed is not None, "streaming board could not be exercised locally")
    port, summary, stream = streamed
    require(
        stream["fields"]["sample_rate_hz"] == 250 and len(stream["fields"]["channels"]) == 16,
        "streaming board must resolve master_board rows and rate",
    )
    line(
        f"transport streaming-board address={address}:{port} chunks={summary['chunks']} "
        f"samples={summary['samples']} rate={stream['fields']['sample_rate_hz']} "
        f"channels={len(stream['fields']['channels'])}"
    )
    verified.append("streaming_board")
    line(f"transports-verified {verified} no_hardware=True no_physical_claim=True")
    return verified


# --------------------------------------------------------------------------- LSL
def check_lsl_loopback():
    from pylsl import StreamInfo, StreamOutlet, local_clock

    source_id = "chronodb-formats-" + os.urandom(4).hex()
    outlet = StreamOutlet(StreamInfo("formats test", "EEG", 2, 250, "float32", source_id))
    stop = threading.Event()
    sent = {}

    def produce():
        count = 0
        start = local_clock()
        while not stop.is_set():
            stamp = start + count / 250
            sent[count] = stamp
            outlet.push_sample([float(count), float(-count)], stamp)
            count += 1
            stop.wait(max(0, start + count / 250 - local_clock()))

    thread = threading.Thread(target=produce)
    thread.start()
    try:
        with recording("lsl_wrong_clock", "unix_us") as (pool, session):
            try:
                sources.run_source(
                    session, "lsl", source_id=source_id, channels=["C3", "C4"],
                    units=["uV", "uV"], seconds=2,
                )
                refused = False
            except ValueError as error:
                refused = "lsl_local_us" in str(error)
            require(refused, "lsl must refuse a session bound to another clock")
            line("lsl clock-guard unix_us session refused with an actionable error")
        with recording("lsl", "lsl_local_us") as (pool, session):
            delivered = []
            session.on_signal = lambda stream, values, times: delivered.append(len(times))
            summary = sources.run_source(
                session, "lsl", source_id=source_id, channels=["C3", "C4"],
                units=["uV", "uV"], seconds=3, expected_rate=250,
            )
            require(summary["samples"] > 250, "LSL samples")
            require(summary["clocks"] > 0, "LSL clock measurements")
            require(len(delivered) == summary["chunks"], "LSL on_signal once per chunk")
            records = queued_records(pool)
            require("clock" in types_of(records), "clock records must be written")
            gaps = [r for r in records if r["fields"]["type"] == "gap"]
            require(
                all(r["fields"]["lost_samples"] is None for r in gaps),
                "an LSL loss count must never be invented",
            )
            line(
                f"lsl loopback chunks={summary['chunks']} samples={summary['samples']} "
                f"clocks={summary['clocks']} gaps={summary['gaps']} "
                f"lsl_local_us=True"
            )
    finally:
        stop.set()
        thread.join(timeout=5)


# --------------------------------------------------------------------------- 7
def _edf_field(value, width):
    raw = str(value).encode("ascii")[:width]
    return raw + b" " * (width - len(raw))


def _phys_range(limit):
    for decade in (4, 3, 2, 1, 0, -1, -2):
        candidate = 10.0 ** (-decade)
        if limit <= candidate:
            text = f"{candidate:.6f}"[:8]
            return -float(text), float(text)
    return -1.0, 1.0


def write_edf(path, data, rate, names, bdf=False):
    """Minimal EDF/BDF container writer (stdlib only).

    mne 1.13 cannot export EDF/BDF without the optional edfio package, which is
    not installed here, so the container is written directly and then read back
    through mne's own read_raw_edf/read_raw_bdf. Field order follows the EDF+
    specification: each header field is grouped across all signals.
    """
    channels, samples = data.shape
    records = samples // rate
    dmin, dmax = (-8388608, 8388607) if bdf else (-32768, 32767)
    limit = float(np.abs(data).max())
    pmin, pmax = _phys_range(limit)
    head = bytearray()
    head += b"\xffBIOSEMI" if bdf else b"0       "
    head += _edf_field("X X X X", 80)
    head += _edf_field("Startdate X X X X", 80)
    head += _edf_field("01.01.20", 8)
    head += _edf_field("00.00.00", 8)
    head += _edf_field(256 * (channels + 1), 8)
    head += _edf_field("EDF+C", 44)
    head += _edf_field(-1, 8)
    head += _edf_field(1, 8)
    head += _edf_field(channels, 4)
    for name in names:
        head += _edf_field(name, 16)
    for _ in names:
        head += _edf_field("AgAgCl electrode", 80)
    for _ in names:
        head += _edf_field("V", 8)
    for _ in names:
        head += _edf_field(f"{pmin:.6f}", 8)
    for _ in names:
        head += _edf_field(f"{pmax:.6f}", 8)
    for _ in names:
        head += _edf_field(dmin, 8)
    for _ in names:
        head += _edf_field(dmax, 8)
    for _ in names:
        head += _edf_field("HP:0.1Hz LP:75Hz", 80)
    for _ in names:
        head += _edf_field(rate, 8)
    for _ in names:
        head += _edf_field("", 32)
    assert len(head) == 256 * (channels + 1), len(head)
    payload = bytearray()
    for record in range(records):
        for channel in range(channels):
            block = data[channel, record * rate : (record + 1) * rate]
            scaled = np.round((block - pmin) / (pmax - pmin) * (dmax - dmin) + dmin)
            scaled = np.clip(scaled, dmin, dmax).astype("<i4")
            if bdf:
                for value in scaled:
                    payload += int(value).to_bytes(3, "little", signed=True)
            else:
                payload += scaled.astype("<i2").tobytes()
    Path(path).write_bytes(bytes(head) + bytes(payload))


def write_mne_files():
    import mne

    data = sample_data()
    files = {}
    for bdf, name in ((False, "synthetic.edf"), (True, "synthetic.bdf")):
        path = TMP / name
        write_edf(path, data, RATE, NAMES, bdf=bdf)
        files["bdf" if bdf else "edf"] = path
    info = mne.create_info(NAMES, float(RATE), ["eeg"] * CHANNELS)
    raw = mne.io.RawArray(data, info, verbose="ERROR")
    raw.set_annotations(
        mne.Annotations(onset=[1.0], duration=[0.5], description=["BAD test"]),
        verbose="ERROR",
    )
    raw.info["bads"] = [NAMES[2]]
    fif = TMP / "synthetic_raw.fif"
    raw.save(str(fif), overwrite=True, verbose="ERROR")
    files["fif"] = fif
    vhdr = TMP / "synthetic_raw.vhdr"
    mne.export.export_raw(str(vhdr), raw, fmt="brainvision", overwrite=True, verbose="ERROR")
    files["vhdr"] = vhdr
    return files, data


def check_file_formats():
    files, data = write_mne_files()
    checks = {
        "edf": ("values", 0.0, set()),
        "bdf": ("values", 0.0, set()),
        "fif": ("events", 1e-12, {"artifact", "bad_channel"}),
        "vhdr": ("events", 1e-12, {"annotation"}),
    }
    for kind, path in sorted(files.items()):
        mode, _atol, wanted = checks[kind]
        require(sources.detect(path) == "mne_file", f"{path.name} must detect as mne_file")
        descriptors, chunks = read_source("mne_file", path=str(path), start_us=1_000_000)
        require(len(descriptors) == 1, f"{kind} descriptor count")
        descriptor = descriptors[0]
        require(descriptor.channels == NAMES, f"{kind} channel names")
        require(descriptor.sample_rate_hz == float(RATE), f"{kind} rate")
        require(descriptor.units == ["V"] * CHANNELS, f"{kind} units")
        require(descriptor.clock_domain == "unix_us", f"{kind} clock domain")
        require(chunks, f"{kind} must yield chunks")
        values = np.concatenate([chunk.values for chunk in chunks], axis=1)
        times = np.concatenate([chunk.times for chunk in chunks])
        require(values.shape == (CHANNELS, SAMPLES), f"{kind} shape {values.shape}")
        require(
            values.dtype in (np.float32, np.float64), f"{kind} dtype {values.dtype}"
        )
        # The MNE readers return float64 and the chunk keeps that precision. Downcasting
        # here silently rounded a recording and broke scripts/bci-test.py.
        require(
            values.dtype == np.float64, f"{kind} must keep the reader precision"
        )
        require(np.isfinite(values).all(), f"{kind} finite samples")
        require(
            np.allclose(times, 1.0 + np.arange(SAMPLES) / RATE, atol=1e-9),
            f"{kind} times must be the original source seconds",
        )
        require(
            all(
                chunk.sample_start == index * 1024
                for index, chunk in enumerate(chunks)
            ),
            f"{kind} sample_start",
        )
        error = float(np.abs(values - data).max())
        events = [event for chunk in chunks for event in chunk.events]
        categories = {event["category"] for event in events}
        if mode == "values":
            require(error < 1e-8, f"{kind} round-trip error {error}")
            require(
                categories == set(),
                f"{kind} has no annotations and must not invent events: {categories}",
            )
        require(
            wanted <= categories,
            f"{kind} events {sorted(categories)} must include {sorted(wanted)}",
        )
        line(
            f"format {kind} channels={values.shape[0]} rate={descriptor.sample_rate_hz} "
            f"samples={values.shape[1]} maxerr={error:.3e} events={sorted(categories)} "
            f"labels={sorted({event['label'] for event in events})}"
        )
    line(
        "format-note EDF/BDF containers were written directly (stdlib) because mne 1.13 "
        "export needs the optional edfio package, which is not installed; FIF and "
        "BrainVision were written by mne and read back through read_raw_fif/"
        "read_raw_brainvision. EEGLAB (.set) is registered and read through "
        "read_raw_eeglab but no .set fixture was produced: mne export needs the "
        "optional eeglabio package, which is not installed."
    )


# --------------------------------------------------------------------------- 8
def check_tabular_formats():
    data = sample_data()
    units = ["V"] * CHANNELS

    csv_path = TMP / "synthetic.csv"
    with csv_path.open("w", newline="") as handle:
        handle.write(",".join(NAMES) + "\n")
        for sample in range(SAMPLES):
            handle.write(",".join(f"{value:.12g}" for value in data[:, sample]) + "\n")
    descriptors, chunks = read_source(
        "tabular", path=str(csv_path), channels=NAMES, units=units,
        sample_rate_hz=RATE, start_us=0, layout="samples_channels", has_header=True,
    )
    values = np.concatenate([chunk.values for chunk in chunks], axis=1)
    require(sources.detect(csv_path) == "tabular", "csv detection")
    require(descriptors[0].sample_rate_hz == float(RATE), "csv rate")
    require(values.shape == (CHANNELS, SAMPLES), f"csv shape {values.shape}")
    require(np.isfinite(values).all(), "csv finite")
    require(np.allclose(values, data, atol=1e-9), "csv must preserve the written values")
    line(f"format csv channels={values.shape[0]} samples={values.shape[1]} layout=samples_channels exact=True")

    npy_path = TMP / "synthetic.npy"
    np.save(npy_path, data)
    descriptors, chunks = read_source(
        "tabular", path=str(npy_path), channels=NAMES, units=["uV"] * CHANNELS,
        sample_rate_hz=RATE, start_us=500_000, layout="channels_samples",
    )
    values = np.concatenate([chunk.values for chunk in chunks], axis=1)
    times = np.concatenate([chunk.times for chunk in chunks])
    require(sources.detect(npy_path) == "tabular", "npy detection")
    require(values.shape == (CHANNELS, SAMPLES), f"npy shape {values.shape}")
    require(np.isfinite(values).all(), "npy finite")
    require(np.allclose(values, data, atol=1e-6), "npy must preserve the stored values")
    require(np.allclose(times, 0.5 + np.arange(SAMPLES) / RATE, atol=1e-9), "npy times")
    require(descriptors[0].units == ["uV"] * CHANNELS, "npy units must be the explicit ones")
    line(f"format npy channels={values.shape[0]} samples={values.shape[1]} layout=channels_samples finite=True")

    txt_path = TMP / "openbci_style.txt"
    stamps = np.arange(SAMPLES) / RATE
    with txt_path.open("w", newline="") as handle:
        header = ["Sample Index"] + [f"EXG Channel {i}" for i in range(CHANNELS)]
        handle.write(", ".join(header + ["Timestamp", "Marker"]) + "\n")
        for sample in range(SAMPLES):
            row = [str(sample)] + [f"{value:.9g}" for value in data[:, sample]]
            row += [f"{stamps[sample]:.6f}", "0"]
            handle.write(", ".join(row) + "\n")
    descriptors, chunks = read_source(
        "tabular", path=str(txt_path), channels=NAMES, units=["uV"] * CHANNELS,
        sample_rate_hz=RATE, start_us=0, layout="samples_channels", has_header=True,
        skip_columns=1, trailing_columns=1, time_column=9,
    )
    values = np.concatenate([chunk.values for chunk in chunks], axis=1)
    times = np.concatenate([chunk.times for chunk in chunks])
    require(sources.detect(txt_path) == "tabular", "txt detection")
    require(values.shape == (CHANNELS, SAMPLES), f"txt shape {values.shape}")
    require(np.isfinite(values).all(), "txt finite")
    require(np.allclose(times, stamps, atol=1e-9), "txt must keep the file's own clock column")
    require(np.allclose(values, data, atol=1e-5), "txt values")
    line(
        f"format openbci-txt channels={values.shape[0]} samples={values.shape[1]} "
        f"skip_columns=1 trailing_columns=1 time_column=9 original_times=True"
    )

    from brainflow.data_filter import DataFilter

    board_csv = TMP / "brainflow_board.csv"
    board = np.zeros((5, SAMPLES))
    board[0] = np.arange(SAMPLES)
    board[1] = data[0]
    board[2] = data[1]
    board[3] = 1_000_000.0 + np.arange(SAMPLES)
    board[4] = 0
    DataFilter.write_file(board, str(board_csv), "w")
    descriptors, chunks = read_source(
        "tabular", path=str(board_csv), channels=NAMES[:2], units=["uV", "uV"],
        sample_rate_hz=RATE, start_us=0, layout="samples_channels", has_header=False,
        delimiter="\t", skip_columns=1, trailing_columns=2,
    )
    values = np.concatenate([chunk.values for chunk in chunks], axis=1)
    require(values.shape == (2, SAMPLES), f"brainflow csv shape {values.shape}")
    require(np.isfinite(values).all(), "brainflow csv finite")
    require(np.allclose(values, data[:2], atol=2e-6), "brainflow csv values")
    line(
        f"format brainflow-csv channels={values.shape[0]} samples={values.shape[1]} "
        f"delimiter=tab layout=samples_channels skip_columns=1 trailing_columns=2 "
        f"finite=True"
    )


# --------------------------------------------------------------------------- 9
def check_unit_errors():
    csv_path = TMP / "synthetic.csv"
    npy_path = TMP / "synthetic.npy"
    cases = {
        "csv no units": {"path": str(csv_path), "units": None},
        "csv bare unit string": {"path": str(csv_path), "units": "uV"},
        "csv wrong unit count": {"path": str(csv_path), "units": ["uV"] * 3},
        "npy no units": {"path": str(npy_path), "units": None},
        "npy bare unit string": {"path": str(npy_path), "units": "uV"},
        "npy wrong unit count": {"path": str(npy_path), "units": ["uV"] * 2},
        "npy no sample rate": {
            "path": str(npy_path),
            "units": ["uV"] * CHANNELS,
            "sample_rate_hz": None,
        },
    }
    for label, overrides in cases.items():
        options = {
            "channels": NAMES,
            "units": ["uV"] * CHANNELS,
            "sample_rate_hz": RATE,
            "start_us": 0,
            "layout": "channels_samples",
        }
        options.update(overrides)
        try:
            sources.source("tabular").open(**options)
            refused = False
        except ValueError:
            refused = True
        require(refused, f"{label} must raise ValueError")
        line(f"units-refused {label}")
    line("units-never-inferred csv=True npy=True sample_rate_never_inferred=True")


# --------------------------------------------------------------------------- misc
def check_registry_shape():
    from brainflow.board_shim import BoardIds

    require(
        sources.source_ids() == ("brainflow", "lsl", "mne_file", "synthetic", "tabular"),
        f"registry order {sources.source_ids()}",
    )
    expected = {
        ".edf": "mne_file",
        ".bdf": "mne_file",
        ".fif": "mne_file",
        ".vhdr": "mne_file",
        ".set": "mne_file",
        ".csv": "tabular",
        ".tsv": "tabular",
        ".npy": "tabular",
        ".txt": "tabular",
    }
    for suffix, source_id in expected.items():
        require(
            sources.detect(TMP / f"x{suffix}") == source_id,
            f"detect {suffix} -> {source_id}",
        )
    require(sources.detect(TMP / "x.unknown") is None, "unknown suffix must not detect")
    require(sources.detect(None) is None, "None path must not detect")
    try:
        sources.source("missing")
        refused = False
    except ValueError:
        refused = True
    require(refused, "unknown source id must raise ValueError")
    try:
        sources.register_source(sources.source("synthetic"))
        refused = False
    except ValueError:
        refused = True
    require(refused, "duplicate registration must raise ValueError")
    line(f"registry sources={sources.source_ids()} detect_mapping={sorted(set(expected.values()))}")

    # synthetic spec must reproduce the historical deterministic construction
    from chronograph_connectors.bci_acquisition import synthetic as historical

    class Sink:
        def __init__(self):
            self.streams, self.chunks, self.events = [], [], []

        def stream(self, stream_id, **fields):
            self.streams.append((stream_id, fields))

        def signal(self, stream_id, values, times, **fields):
            self.chunks.append((values, times, fields))

        def event(self, stream_id, timestamp_us, label, **fields):
            self.events.append((timestamp_us, label, fields))

    sink = Sink()
    historical(sink, seconds=2, rate=100, channels=2, start_us=0, seed=42)
    historical_values = np.concatenate([c[0] for c in sink.chunks], axis=1)
    historical_times = np.concatenate([c[1] for c in sink.chunks])
    historical_events = [(e[0], e[1]) for e in sink.events]
    descriptors, chunks = read_source("synthetic", seconds=2, rate=100, channels=2)
    spec_values = np.concatenate([chunk.values for chunk in chunks], axis=1)
    spec_times = np.concatenate([chunk.times for chunk in chunks])
    spec_events = [(event["timestamp_us"], event["label"]) for chunk in chunks for event in chunk.events]
    require(descriptors[0].units == ["V"] * 2, "synthetic units must be V")
    require(
        np.array_equal(spec_values, historical_values.astype("<f4")),
        "synthetic signal must be identical to bci_acquisition.synthetic",
    )
    require(np.allclose(spec_times, historical_times), "synthetic times")
    require(spec_events == historical_events, "synthetic cue events")
    require(
        [len(chunk.times) for chunk in chunks] == [len(c[1]) for c in sink.chunks],
        "synthetic chunk step",
    )
    line(
        f"synthetic-parity samples={spec_values.shape[1]} chunks={len(chunks)} "
        f"cue_events={len(spec_events)} identical=True"
    )

    # brainflow spec resolves the same rows/rate as the catalog for a real board
    synthetic_info = catalog.describe(int(BoardIds.SYNTHETIC_BOARD))
    generator = sources.source("brainflow").open(
        board_id=int(BoardIds.SYNTHETIC_BOARD), units="uV", seconds=0.05
    )
    plan = next(generator)
    require(
        plan.descriptor.sample_rate_hz == synthetic_info["sampling_rate"]
        and plan.descriptor.channels == synthetic_info["channel_names"],
        "brainflow descriptor must come from the catalog",
    )
    require(plan.descriptor.clock_domain == "unix_us", "brainflow clock domain")
    generator.close()
    line(
        f"brainflow-descriptor board=SYNTHETIC_BOARD channels={len(synthetic_info['channel_names'])} "
        f"rate={synthetic_info['sampling_rate']} modality={synthetic_info['modality']} "
        f"clock_domain=unix_us"
    )


class _Recorder:
    """Minimal session double for writer-guard checks; no spool and no server."""

    def __init__(self):
        self.streams, self.clocks = [], 0

    def stream(self, stream_id, **fields):
        self.streams.append(stream_id)

    def signal(self, stream_id, values, times, **fields):
        return None

    def event(self, stream_id, timestamp_us, label, **fields):
        return None

    def gap(self, stream_id, start_us, end_us, **fields):
        return None

    def clock_measurement(self, stream_id, timestamp_us, offset_seconds, **fields):
        self.clocks += 1


def _probe_spec(descriptor, chunks):
    return sources.SourceSpec(
        id="writer_probe",
        family="test",
        formats=(".probe",),
        description="writer guard probe",
        detect=lambda path: False,
        open=lambda **options: iter([sources.StreamPlan(descriptor, iter(chunks))]),
    )


def _probe_chunk(**overrides):
    fields = {
        "values": np.zeros((2, 4), dtype="<f4"),
        "times": np.arange(4) / RATE,
        "sample_start": 0,
        "segment_id": "probe",
    }
    fields.update(overrides)
    return sources.Chunk(**fields)


def check_writer_guards():
    descriptor = sources.StreamDescriptor(
        channels=["A", "B"],
        units=["uV", "uV"],
        channel_types=["EEG", "EEG"],
        sample_rate_hz=float(RATE),
        reference="test",
        clock_domain="unix_us",
        source_clock=None,
        modality="eeg",
        provenance={"stream_id": "eeg"},
    )
    summary = sources.run_source(
        _Recorder(),
        _probe_spec(
            descriptor,
            [
                _probe_chunk(
                    events=[{"timestamp_us": 0, "label": "cue", "category": "cue"}],
                    gaps=[
                        {
                            "start_us": 0,
                            "end_us": 1,
                            "reason": "probe",
                            "lost_samples": None,
                        }
                    ],
                    clocks=[
                        {
                            "timestamp_us": 0,
                            "offset_seconds": 0.0,
                            "source_clock": "probe",
                        }
                    ],
                )
            ],
        ),
    )
    require(
        summary
        == {
            "source": "writer_probe",
            "streams": 1,
            "chunks": 1,
            "samples": 4,
            "events": 1,
            "gaps": 1,
            "clocks": 1,
        },
        f"writer summary {summary}",
    )
    cases = {
        "wrong channel count": _probe_chunk(
            values=np.zeros((3, 4), dtype="<f4")
        ),
        "unordered timestamps": _probe_chunk(times=[0.0, 0.02, 0.01]),
        "zero samples": _probe_chunk(
            values=np.zeros((2, 0), dtype="<f4"), times=np.zeros(0)
        ),
        "missing event label": _probe_chunk(
            events=[{"timestamp_us": 0, "category": "cue"}]
        ),
        "gap ends before it starts": _probe_chunk(
            gaps=[{"start_us": 5, "end_us": 1, "reason": "probe"}]
        ),
        "gap without reason": _probe_chunk(gaps=[{"start_us": 0, "end_us": 1}]),
        "invented lost-sample count": _probe_chunk(
            gaps=[
                {
                    "start_us": 0,
                    "end_us": 1,
                    "reason": "probe",
                    "lost_samples": -1,
                }
            ]
        ),
    }
    for label, chunk in cases.items():
        try:
            sources.run_source(_Recorder(), _probe_spec(descriptor, [chunk]))
            refused, message = False, ""
        except ValueError as error:
            refused, message = True, str(error)
        require(refused and message, f"malformed chunk ({label}) must raise ValueError")
        line(f"writer-guard refused {label}: {message[:64]}")


def check_input_bounds():
    csv_path = TMP / "synthetic.csv"
    edf_path = TMP / "synthetic.edf"
    stubbed = {
        "synthetic channels=0": {"seconds": 1, "rate": RATE, "channels": 0},
        "synthetic channels=513": {"seconds": 1, "rate": RATE, "channels": 513},
        "synthetic rate=79": {"seconds": 1, "rate": 79, "channels": 2},
        "synthetic rate=100001": {"seconds": 1, "rate": 100_001, "channels": 2},
        "synthetic seconds=0": {"seconds": 0, "rate": RATE, "channels": 2},
        "synthetic seconds=90000": {"seconds": 90_000, "rate": RATE, "channels": 2},
    }
    for label, options in stubbed.items():
        try:
            sources.source("synthetic").open(**options)
            refused = False
        except ValueError:
            refused = True
        require(refused, f"{label} must raise ValueError")
        line(f"bounds-refused {label}")
    tabular = {
        "tabular channels=0": {"channels": [], "units": []},
        "tabular rate=79": {"channels": NAMES, "units": ["uV"] * CHANNELS,
                            "sample_rate_hz": 79},
        "tabular rate=100001": {"channels": NAMES, "units": ["uV"] * CHANNELS,
                                "sample_rate_hz": 100_001},
        "tabular negative start_us": {"channels": NAMES, "units": ["uV"] * CHANNELS,
                                      "start_us": -1},
        "tabular unknown layout": {"channels": NAMES, "units": ["uV"] * CHANNELS,
                                   "layout": "rows"},
    }
    for label, overrides in tabular.items():
        options = {
            "path": str(csv_path),
            "channels": NAMES,
            "units": ["uV"] * CHANNELS,
            "sample_rate_hz": RATE,
            "start_us": 0,
        }
        options.update(overrides)
        try:
            sources.source("tabular").open(**options)
            refused = False
        except ValueError:
            refused = True
        require(refused, f"{label} must raise ValueError")
        line(f"bounds-refused {label}")
    link_csv = TMP / "symlink.csv"
    link_edf = TMP / "symlink.edf"
    if not link_csv.exists():
        os.symlink(csv_path, link_csv)
    if not link_edf.exists():
        os.symlink(edf_path, link_edf)
    for label, call in {
        "tabular symlink": lambda: sources.source("tabular").open(
            path=str(link_csv), channels=NAMES, units=["uV"] * CHANNELS,
            sample_rate_hz=RATE, start_us=0,
        ),
        "mne_file symlink": lambda: sources.source("mne_file").open(
            path=str(link_edf), start_us=0
        ),
        "mne_file unsupported suffix": lambda: sources.source("mne_file").open(
            path=str(TMP / "not_a_recording.xyz"), start_us=0
        ),
    }.items():
        try:
            call()
            refused = False
        except ValueError:
            refused = True
        require(refused, f"{label} must raise ValueError")
        line(f"bounds-refused {label}")
    line("bounds regular-files-only=True symlinks-refused=True")


def main():
    package = Path(chronograph_connectors.__file__).resolve()
    require(
        package == (PACKAGE / "chronograph_connectors" / "__init__.py").resolve(),
        f"the repo source must be imported, saw {package}",
    )
    line(f"repo-source package={package}")
    line(f"interpreter {sys.version.split()[0]} numpy={np.__version__} workdir={TMP}")
    line("notice: no physical board is used or claimed; synthetic board, file and multicast transports only")
    caps = check_capabilities()
    check_every_board()
    check_modality_groups()
    check_transports_classification()
    check_shimmer_and_fabrication()
    verified = check_brainflow_transports()
    check_lsl_loopback()
    check_file_formats()
    check_tabular_formats()
    check_unit_errors()
    check_writer_guards()
    check_input_bounds()
    check_registry_shape()
    line(f"OK checks={CHECKS} board_ids={caps['board_ids']} described={caps['described']} "
         f"transports_verified={len(verified)} formats=edf,bdf,fif,vhdr,csv,npy,txt,brainflow-csv "
         f"sources={','.join(sources.source_ids())}")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as error:
        print(f"FAILED assertion: {error}", file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        import traceback

        traceback.print_exc()
        print(f"FAILED {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
