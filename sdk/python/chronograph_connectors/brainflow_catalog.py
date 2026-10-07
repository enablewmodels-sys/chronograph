"""Complete BrainFlow board catalog derived from the installed library.

Every fact here comes from the installed brainflow package at call time. The
documented vendor grouping is data (VENDORS); a board is described by calling
BoardShim.get_board_descr(board_id, preset) FIRST and deriving the device name,
sampling rate, row count, row groups, channel names and special rows from that
descriptor. The convenience accessors (get_device_name, get_sampling_rate,
get_eeg_channels, get_timestamp_channel, ...) are used only as a fallback when the
descriptor omits a key, and a raising accessor yields None rather than a guess.

Verified against the installed driver (5.23.0 when the shipped catalogue was generated):
get_board_descr returns a full descriptor for
boards whose eeg accessors raise (CALLIBRI_EMG 10, CALLIBRI_ECG 11, GFORCE_PRO 16,
GFORCE_DUAL 19, ANT_NEURO_EE_410 24, EMOTIBIT 47), and NO_BOARD (-100) has no
descriptor at all. NO_BOARD, PLAYBACK_FILE_BOARD (-3) and STREAMING_BOARD (-2) are
transports, not devices: they are reported under transports, never as boards, and
no sampling rate is invented for them. BrainFlow documents a Shimmer vendor
(Shimmer3) that has no member in the installed BoardIds enum; it is reported as
documented-but-unavailable and no id, name or rate is fabricated for it.

brainflow is imported inside the functions, so importing this module needs only
the standard library.
"""

import math

# Every vendor the installed driver ships a board for, keyed by the BoardIds member
# names it owns, so the catalog cannot drift from the installed enum. A board the
# driver defines but this table omits reached the console as the placeholder vendor
# "undocumented", which hid 28 real boards behind one meaningless group.
#
# WHY the table is wider than BrainFlow's Supported Boards page: that page documents 18
# vendors and lists one or two members each, while the library defines 67 members. The
# authority used below is the driver's own board factory and its vendor source tree -
# src/board_controller/board_controller.cpp, which names the controller class each
# BoardIds member is constructed with, inside the vendor directory that class lives in
# (ant_neuro, aavaa, ntl, synchroni, mentalab, muse, neuromd, openbci, oymotion). The
# Supported Boards page is a subset of that, and its 5.22.0 revision dropped the Ganglion
# and BLED sections while the members remained.
#
# Two entries deserve naming, because a name is all they have. The OB-series boards
# (60 OB5000, 63 OB3000) are built by SynchroniBoard in src/board_controller/synchroni,
# the controller the SYNCHRONI members share, and OYMotion markets an OB3000 of its own:
# the driver's classification is followed here and the ambiguity is left visible rather
# than resolved by guessing. NTL owns src/board_controller/ntl and BrainFlow's page names
# no vendor for it, so the group carries the library's own short name.
VENDORS = {
    "Dummy boards": ("PLAYBACK_FILE_BOARD", "STREAMING_BOARD", "SYNTHETIC_BOARD"),
    "OpenBCI": (
        "GALEA_BOARD",
        "CYTON_BOARD",
        "GANGLION_BOARD",
        "GANGLION_NATIVE_BOARD",
        "CYTON_DAISY_BOARD",
        "GANGLION_WIFI_BOARD",
        "CYTON_WIFI_BOARD",
        "CYTON_DAISY_WIFI_BOARD",
    ),
    "NeuroMD": (
        "BRAINBIT_BOARD",
        "BRAINBIT_BLED_BOARD",
        "CALLIBRI_EEG_BOARD",
        "CALLIBRI_EMG_BOARD",
        "CALLIBRI_ECG_BOARD",
    ),
    "G.TEC": ("UNICORN_BOARD",),
    "Neurosity": ("NOTION_1_BOARD", "NOTION_2_BOARD", "CROWN_BOARD"),
    "OYMotion": (
        "GFORCE_PRO_BOARD",
        "GFORCE_DUAL_BOARD",
        "OB3000_24_CHANNELS_BOARD",
        "OB5000_8_CHANNELS_BOARD",
    ),
    "FreeEEG": ("FREEEEG32_BOARD", "FREEEEG128_BOARD"),
    "Muse": (
        "MUSE_S_BOARD",
        "MUSE_S_ATHENA_BOARD",
        "MUSE_2_BOARD",
        "MUSE_2016_BOARD",
        "MUSE_S_BLED_BOARD",
        "MUSE_2_BLED_BOARD",
        "MUSE_2016_BLED_BOARD",
    ),
    "Ant Neuro": (
        "ANT_NEURO_EE_410_BOARD",
        "ANT_NEURO_EE_411_BOARD",
        "ANT_NEURO_EE_430_BOARD",
        "ANT_NEURO_EE_511_BOARD",
        "ANT_NEURO_EE_211_BOARD",
        "ANT_NEURO_EE_212_BOARD",
        "ANT_NEURO_EE_213_BOARD",
        "ANT_NEURO_EE_214_BOARD",
        "ANT_NEURO_EE_215_BOARD",
        "ANT_NEURO_EE_221_BOARD",
        "ANT_NEURO_EE_222_BOARD",
        "ANT_NEURO_EE_223_BOARD",
        "ANT_NEURO_EE_224_BOARD",
        "ANT_NEURO_EE_225_BOARD",
    ),
    "Enophone": ("ENOPHONE_BOARD",),
    "BrainAlive": ("BRAINALIVE_BOARD",),
    "Mentalab": (
        "EXPLORE_4_CHAN_BOARD",
        "EXPLORE_8_CHAN_BOARD",
        "EXPLORE_PLUS_8_CHAN_BOARD",
        "EXPLORE_PLUS_32_CHAN_BOARD",
    ),
    "EmotiBit": ("EMOTIBIT_BOARD",),
    "PiEEG": ("PIEEG_BOARD",),
    "NeuroPawn": ("NEUROPAWN_KNIGHT_BOARD", "NEUROPAWN_KNIGHT_BOARD_IMU"),
    "BioListener": ("BIOLISTENER_BOARD",),
    "IronBCI": ("IRONBCI_32_BOARD",),
    # Present in 5.23.0 and absent from 5.22.2, which is why availability is decided by
    # the installed enum rather than by this table.
    "Shimmer": ("SHIMMER3_BOARD",),
    "AAVAA": ("AAVAA_V3_BOARD",),
    "NTL": ("NTL_WIFI_BOARD",),
    "Synchroni": (
        "SYNCHRONI_UNO_1_CHANNELS_BOARD",
        "SYNCHRONI_TRIO_3_CHANNELS_BOARD",
        "SYNCHRONI_OCTO_8_CHANNELS_BOARD",
        "SYNCHRONI_PENTO_8_CHANNELS_BOARD",
    ),
}

# Transports: data movers, not devices. They have no sampling rate of their own.
TRANSPORTS = {
    "NO_BOARD": -100,
    "PLAYBACK_FILE_BOARD": -3,
    "STREAMING_BOARD": -2,
}
TRANSPORT_IDS = tuple(TRANSPORTS.values())

PRESET_NAMES = {0: "DEFAULT_PRESET", 1: "AUXILIARY_PRESET", 2: "ANCILLARY_PRESET"}
PRESET_FILES = {0: None, 1: "file_aux", 2: "file_anc"}

UNDOCUMENTED_VENDOR = "undocumented"
_MODALITY_SUFFIX = "_channels"

# Stable preference order for the primary row group. "exg" is included because
# some descriptors group all exg rows that way.
PRIMARY_ORDER = (
    "eeg",
    "exg",
    "emg",
    "ecg",
    "eog",
    "eda",
    "ppg",
    "optical",
    "accel",
    "gyro",
    "magnetometer",
    "rotation",
    "temperature",
    "resistance",
    "analog",
    "other",
)
PREFIXES = {
    "eeg": "EEG",
    "exg": "EXG",
    "emg": "EMG",
    "ecg": "ECG",
    "eog": "EOG",
    "eda": "EDA",
    "ppg": "PPG",
    "optical": "OPT",
    "accel": "ACC",
    "gyro": "GYR",
    "magnetometer": "MAG",
    "rotation": "ROT",
    "temperature": "TEMP",
    "resistance": "IMP",
    "analog": "AIO",
    "other": "OTHER",
}

_VENDOR_BY_MEMBER = {
    member: vendor for vendor, members in VENDORS.items() for member in members
}


def _board_ids():
    """Member name to numeric id for every installed BoardIds member."""
    from brainflow.board_shim import BoardIds

    return {
        name: int(getattr(BoardIds, name))
        for name in dir(BoardIds)
        if name.isupper() and not name.startswith("_")
    }


def _member_name(board_id):
    for name, value in _board_ids().items():
        if value == board_id:
            return name
    return None


def _fallback(accessor, *args):
    """Convenience accessor value, or None when the library refuses to answer."""
    if accessor is None:
        return None
    try:
        return accessor(*args)
    except Exception:
        return None


def _index_rows(descr):
    """Row groups by modality found in a descriptor, e.g. {"eeg": [1, 2, 3]}."""
    rows = {}
    for key, value in descr.items():
        if not key.endswith(_MODALITY_SUFFIX) or not isinstance(value, (list, tuple)):
            continue
        indices = []
        for item in value:
            if isinstance(item, bool) or not isinstance(item, int):
                indices = []
                break
            indices.append(int(item))
        if indices:
            rows[key[: -len(_MODALITY_SUFFIX)]] = indices
    return rows


def _primary(rows):
    """First present modality in the stable order, then any remaining group."""
    ordered = [key for key in PRIMARY_ORDER if key in rows]
    ordered += [key for key in sorted(rows) if key not in PRIMARY_ORDER]
    return ordered[0] if ordered else None


def _names(descr, modality, rows):
    if modality == "eeg":
        names = descr.get("eeg_names")
        if isinstance(names, str) and names.strip():
            split = [name.strip() for name in names.split(",") if name.strip()]
            if len(split) == len(rows):
                return split
        if isinstance(names, (list, tuple)):
            split = [str(name).strip() for name in names if str(name).strip()]
            if len(split) == len(rows):
                return split
    prefix = PREFIXES.get(modality, (modality or "ch").upper())
    return [f"{prefix}{index + 1}" for index in range(len(rows))]


def describe(board_id, preset=0):
    """Descriptor-driven description of one board at one preset.

    board_id is a BoardIds value. preset is 0 (default), 1 (auxiliary) or
    2 (ancillary). Unknown ids raise; a board the library cannot describe is
    reported with describable=False and no invented rate.
    """
    from brainflow.board_shim import BoardShim

    if isinstance(board_id, bool) or not isinstance(board_id, int):
        raise ValueError("board_id must be an integer BrainFlow BoardIds value")
    if type(preset) is not int or preset not in PRESET_NAMES:
        raise ValueError(
            "preset must be 0 (default), 1 (auxiliary) or 2 (ancillary)"
        )
    member = _member_name(board_id)
    if member is None:
        raise ValueError(
            f"Unknown BrainFlow board id {board_id}; use a BoardIds member"
        )
    info = {
        "board_id": board_id,
        "board_name": member,
        "device_name": None,
        "vendor": _VENDOR_BY_MEMBER.get(member, UNDOCUMENTED_VENDOR),
        "preset": preset,
        "preset_name": PRESET_NAMES[preset],
        "sampling_rate": None,
        "num_rows": None,
        "rows": {},
        "primary_rows": [],
        "channel_names": [],
        "modality": None,
        "timestamp_channel": None,
        "package_num_channel": None,
        "marker_channel": None,
        "battery_channel": None,
        "transport": member in TRANSPORTS,
        "undocumented_vendor": _VENDOR_BY_MEMBER.get(member) is None,
        "describable": False,
    }
    descr = _fallback(BoardShim.get_board_descr, board_id, preset)
    if isinstance(descr, dict):
        name = descr.get("name")
        if isinstance(name, str) and name:
            info["device_name"] = name
        rows = _index_rows(descr)
        info["rows"] = rows
        modality = _primary(rows)
        info["modality"] = modality
        info["primary_rows"] = list(rows.get(modality, [])) if modality else []
        info["channel_names"] = (
            _names(descr, modality, info["primary_rows"]) if modality else []
        )
        rate = descr.get("sampling_rate")
        if (
            not isinstance(rate, bool)
            and isinstance(rate, (int, float))
            and math.isfinite(rate)
            and rate > 0
        ):
            info["sampling_rate"] = rate
        count = descr.get("num_rows")
        if type(count) is int and count > 0:
            info["num_rows"] = count
        for field, key in (
            ("timestamp_channel", "timestamp_channel"),
            ("package_num_channel", "package_num_channel"),
            ("marker_channel", "marker_channel"),
            ("battery_channel", "battery_channel"),
        ):
            value = descr.get(key)
            if type(value) is int and value >= 0:
                info[field] = value
    # Fallback accessors, only for keys the descriptor did not provide.
    if info["device_name"] is None:
        value = _fallback(BoardShim.get_device_name, board_id)
        if isinstance(value, str) and value:
            info["device_name"] = value
    if info["sampling_rate"] is None:
        value = _fallback(BoardShim.get_sampling_rate, board_id, preset)
        if (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
            and value > 0
        ):
            info["sampling_rate"] = value
    if info["num_rows"] is None:
        value = _fallback(getattr(BoardShim, "get_num_rows", None), board_id)
        if type(value) is int and value > 0:
            info["num_rows"] = value
    for field, accessor in (
        ("timestamp_channel", "get_timestamp_channel"),
        ("package_num_channel", "get_package_num_channel"),
        ("marker_channel", "get_marker_channel"),
        ("battery_channel", "get_battery_channel"),
    ):
        if info[field] is None:
            value = _fallback(getattr(BoardShim, accessor, None), board_id, preset)
            if type(value) is int and value >= 0:
                info[field] = value
    info["describable"] = bool(
        info["sampling_rate"] is not None and info["num_rows"] is not None
    )
    return info


def catalog():
    """Every installed BoardIds member, with transports kept separate."""
    from brainflow.board_shim import BoardShim

    boards, transports, undescribed = {}, {}, []
    for member, board_id in sorted(_board_ids().items(), key=lambda row: row[1]):
        info = describe(board_id)
        if board_id in TRANSPORT_IDS:
            info["transport_kind"] = member
            transports[member] = info
            continue
        boards[member] = info
        if not info["describable"]:
            undescribed.append(member)
    unavailable = {
        vendor: list(members)
        for vendor, members in VENDORS.items()
        if not any(member in _board_ids() for member in members)
    }
    # Transports are not devices and are reported under their own key, so a transport
    # that owns no vendor must not also be counted as an undocumented board.
    undocumented = sorted(
        member
        for member in _board_ids()
        if member not in _VENDOR_BY_MEMBER and member not in TRANSPORTS
    )
    return {
        "brainflow_version": BoardShim.get_version(),
        "vendors": {
            vendor: [member for member in members if member in _board_ids()]
            for vendor, members in VENDORS.items()
        },
        "boards": boards,
        "transports": transports,
        "unavailable_vendors": unavailable,
        "undocumented_boards": undocumented,
        "counts": {
            "boards": len(boards),
            "transports": len(transports),
            "describable": len(boards) - len(undescribed),
            "undescribed": len(undescribed),
            "undocumented": len(undocumented),
        },
    }


def presets(board_id):
    """One describe() entry per preset the installed library reports."""
    from brainflow.board_shim import BoardShim

    if isinstance(board_id, bool) or not isinstance(board_id, int):
        raise ValueError("board_id must be an integer BrainFlow BoardIds value")
    values = _fallback(BoardShim.get_board_presets, board_id)
    if not values:
        return []
    result = []
    for preset in values:
        if type(preset) is not int or preset not in PRESET_NAMES:
            raise ValueError(f"Library reported an unknown preset value {preset!r}")
        result.append(describe(board_id, preset))
    return result


def capabilities():
    """Honest summary of what the installed library can describe."""
    report = catalog()
    boards = report["boards"]
    undescribed = sorted(
        member for member, info in boards.items() if not info["describable"]
    )
    return {
        "brainflow_version": report["brainflow_version"],
        "board_ids": len(boards),
        "described": len(boards) - len(undescribed),
        "undescribed": undescribed,
        "transports": sorted(report["transports"]),
        "unavailable_vendors": sorted(report["unavailable_vendors"]),
        "undocumented_boards": report["undocumented_boards"],
        "vendors": len(VENDORS),
        "preset_names": {str(key): value for key, value in PRESET_NAMES.items()},
        "counts": report["counts"],
    }


def missing_documented():
    """Documented vendors with no member in the installed BoardIds enum."""
    present = _board_ids()
    return [
        vendor
        for vendor, members in VENDORS.items()
        if not any(member in present for member in members)
    ]


def transport_options():
    """Every BrainFlow transport documented as data, in one place."""
    from brainflow.board_shim import BoardIds, BrainFlowPresets

    return {
        "live_board": {
            "board_id": "the device's own BoardIds value",
            "params": [
                "serial_port",
                "ip_address",
                "ip_port",
                "mac_address",
                "serial_number",
                "timeout",
                "other_info",
            ],
            "note": "Real hardware, or SYNTHETIC_BOARD for a hardware-free board.",
        },
        "playback_file": {
            "board_id": int(BoardIds.PLAYBACK_FILE_BOARD),
            "params": {
                "master_board": "BoardIds value of the board that recorded the file",
                "file": "path to the default-preset streamer file",
                "file_aux": "optional auxiliary-preset streamer file",
                "file_anc": "optional ancillary-preset streamer file",
            },
            "master_board_required": True,
            "note": (
                "Rows, sampling rate and presets come from master_board; the "
                "playback board itself owns none of them."
            ),
        },
        "streaming_board": {
            "board_id": int(BoardIds.STREAMING_BOARD),
            "params": {
                "master_board": "BoardIds value of the producing board",
                "ip_address": "multicast address, 224.0.0.0-239.255.255.255",
                "ip_port": "multicast port",
                "ip_address_aux": "optional auxiliary multicast address",
                "ip_port_aux": "optional auxiliary multicast port",
                "ip_address_anc": "optional ancillary multicast address",
                "ip_port_anc": "optional ancillary multicast port",
            },
            "multicast_uri": "streaming_board://<address>:<port>",
            "alternate_param": "other_info may carry the streaming_board:// URI form",
            "master_board_required": True,
            "note": (
                "The producer registers the same multicast address with "
                "add_streamer(); the consumer only needs master_board plus the "
                "address and port."
            ),
        },
        "streamer_output": {
            "api": 'BoardShim.add_streamer("file://NAME:w"|"file://NAME:a", preset)',
            "modes": {"w": "write (truncate)", "a": "append"},
            "schemes": ["file://", "streaming_board://"],
            "presets": [
                {"name": "DEFAULT_PRESET", "value": int(BrainFlowPresets.DEFAULT_PRESET)},
                {
                    "name": "AUXILIARY_PRESET",
                    "value": int(BrainFlowPresets.AUXILIARY_PRESET),
                },
                {
                    "name": "ANCILLARY_PRESET",
                    "value": int(BrainFlowPresets.ANCILLARY_PRESET),
                },
            ],
            "note": "A streamer must be added between prepare_session and start_stream.",
        },
        "presets": [
            {
                "name": PRESET_NAMES[preset],
                "value": preset,
                "file_param": PRESET_FILES[preset],
                "read": "BoardShim.get_board_data(preset=...)",
                "describe": "BoardShim.get_board_descr(board_id, preset)",
            }
            for preset in sorted(PRESET_NAMES)
        ],
        "honesty": (
            "Transports are not devices: no sampling rate, channel name or device "
            "name is invented for them. Rows and rates are always resolved from "
            "master_board."
        ),
    }
