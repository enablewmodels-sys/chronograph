# BCI device and file formats

ChronoDB records what your acquisition software actually produced. It does not install
a driver, invent a sampling rate, convert units or claim hardware certification.
Every board and format below is described by the local BrainFlow installation, so the
catalog cannot drift from the driver you actually have.

## One encoder, declarative sources

`sdk/python/chronograph_connectors/sources/` holds one registry. A source is a data
description (`SourceSpec`) plus a single generic writer (`run_source`) that performs every
session write: stream declaration, chunked signal publication, gap records, marker events,
package-counter discontinuities, clock measurements and the durable spool cursor.
Adding a board, a preset or a file format is a registry row, not a new code path.

| Source | Formats | Notes |
| --- | --- | --- |
| `synthetic` | generated | Deterministic; the only source exercised by tests |
| `brainflow` | live board, playback file, streaming, streamer file, all presets | Descriptor-driven; see below |
| `lsl` | `signal-v1` local stream | Resolves exactly one outlet by `source_id`; local clock only |
| `mne_file` | EDF, BDF, FIF, BrainVision, EEGLAB | Voltage channels only; annotations and bad channels preserved |
| `tabular` | CSV, TSV, NPY, OpenBCI TXT, BrainFlow CSV | Units, channels and rate must be supplied explicitly |

The four acquisition entry points (`bci_acquisition.synthetic`, `.recorded_file`,
`.brainflow_capture`, `.lsl_capture`) remain available and now delegate to this registry, so
earlier scripts and notebooks keep working. The lower-level helpers in `adapters` are unchanged:
they still build normalized records directly for callers that already hold arrays.

## BrainFlow coverage

`chronograph_connectors.brainflow_catalog` resolves a board by reading
`BoardShim.get_board_descr(board_id, preset)` first and only falls back to the convenience
accessors. That order matters. Each row below is measured against the installed driver
(5.23.0 when this snapshot was generated) rather than copied from a vendor page:

| Board | `get_device_name` | `get_sampling_rate` | `get_eeg_channels` | `get_eeg_names` |
| --- | --- | --- | --- | --- |
| Cyton (0) | Cyton | 250 | 8 rows | 8 names |
| Ganglion (1) | Ganglion | 200 | 4 rows | raises |
| Callibri EEG (9) | CallibriEEG | 250 | 1 row | raises |
| Callibri EMG (10) | CallibriEMG | 1000 | raises | raises |
| Callibri ECG (11) | CallibriECG | 125 | raises | raises |
| gForce Pro (16) | GforcePro | 500 | raises | raises |
| gForce Dual (19) | GforceDual | 500 | raises | raises |
| Ant Neuro EE-410 (24) | AntNeuroEE410 | 2000 | raises | raises |
| EmotiBit (47) | Emotibit | 25 | raises | raises |

`get_eeg_channels` and `get_eeg_names` raise for a board with no EEG rows even though its
descriptor is complete, and `get_eeg_names` also raises where the descriptor carries a plain
name string. Deriving geometry from the descriptor supports every one of them.

A board with no EEG rows resolves through the modality group it actually has, so EMG, PPG,
optical, EDA, ECG, EOG, accelerometer, gyroscope, rotation, analog, temperature, resistance and
magnetometer boards are supported and are never relabelled as EEG.

```python
from chronograph_connectors.brainflow_catalog import capabilities, catalog, describe, presets

print(capabilities())          # installed version, real board and preset counts, gaps
board = describe(1)            # Ganglion: descriptors, rows, names, rate, modality
for preset in presets(38):     # Muse 2 and its presets, each described separately
    print(preset["preset_name"], preset["sampling_rate"])
```

### Documented vendor coverage

BrainFlow documents these vendor groups. Names are BrainFlow device names; the ID is the
`BoardIds` member in your installed library.

Vendor labels come from `VENDORS` in `brainflow_catalog.py`. Every member the installed library
defines now belongs to one: the table names the 18 vendors BrainFlow documents on its Supported
Boards page, and the members that page never grouped - the Wi-Fi and BLED variants, Ant Neuro
EE-211 to EE-225/411/430/511, Mentalab Explore Plus, AAVAA, NTL, Synchroni and the OB3000/5000 -
are placed by the driver's own board factory, which constructs each of them from a controller class
inside a vendor source directory. A board the table omits would carry `vendor == "undocumented"`
and appear in `catalog()["undocumented_boards"]`; that set is empty today, and
`scripts/bci-formats-test.py` fails if a driver upgrade adds a member nobody has attributed. Add a
label there when it does.

| Vendor | Devices |
| --- | --- |
| Dummy boards | Playback File (-3), Streaming (-2), Synthetic (-1) - transports, not devices |
| OpenBCI | Galea, Cyton, Ganglion, Ganglion Native, Cyton Daisy, Ganglion and Cyton Wi-Fi variants |
| NeuroMD | BrainBit, BrainBit BLED, Callibri EEG, Callibri EMG, Callibri ECG |
| G.TEC | Unicorn |
| Neurosity | Notion 1, Notion 2, Crown |
| OYMotion | gForce Pro armband, gForce Dual armband |
| FreeEEG | FreeEEG32, FreeEEG128 |
| Muse | Muse S, MuseS Athena, Muse 2, Muse 2016, and BLED variants |
| Ant Neuro | EE-410, EE-411, EE-430, EE-211 to EE-225, EE-511 |
| Enophone | Enophone headphones |
| BrainAlive | BrainAlive device |
| Mentalab | Explore 4, Explore 8, Explore Plus 8, Explore Plus 32 |
| EmotiBit | EmotiBit board |
| PiEEG | PiEEG board |
| NeuroPawn | Knight board, Knight IMU board |
| BioListener | BioListener board |
| IronBCI | IronBCI32 |
| Shimmer | Shimmer3 - present in 5.23.0; on 5.22.2 the same name is reported unavailable, never fabricated |

The installed library also defines boards the vendor page does not list, including NTL WiFi,
AAVAA V3, Synchroni Trio/Octo/Pento/Uno, OB5000 and OB3000. The catalog reports everything the
installed `BoardIds` enum defines, and `capabilities()` reports vendors that are documented but
**absent** from it. That set moves with the driver: Shimmer3 was reported unavailable on 5.22.2 and
is present on 5.23.0, and the catalogue follows whichever driver is installed rather than inventing
a board ID, device name or sampling rate for a device the driver cannot open.

### Every BrainFlow transport

| Transport | How |
| --- | --- |
| Live board | `prepare_session`, `start_stream`, `get_board_data` / `get_current_board_data` |
| Playback file | `PLAYBACK_FILE_BOARD` with `BrainFlowInputParams.file` |
| Streaming board | `STREAMING_BOARD` with `BrainFlowInputParams.other_info` multicast group and port |
| Streamer output | `add_streamer("file://NAME:w")` to write, `:a` to append, then replay through the playback board |
| Presets | Default, auxiliary and ancillary, each with its own descriptor, rate and `file_aux` / `file_anc` slot |

Every source chooses how many samples share one durable commit. `chunk_samples` covers the
synthetic generator and the file readers; `pull_samples` covers LSL. Bigger budgets mean fewer
disk synchronizations for exactly the same samples, which is the lever a closed loop needs:

| Budget | Commits for 2000 samples | Time | Duty cycle of one 250 Hz stream |
| --- | ---: | ---: | ---: |
| 62 samples (default) | 37 | 1.25 s | 15.6% |
| 500 samples | 8 | 0.21 s | 2.6% |

Measured on one host by `scripts/bci-integration-test.py`; both rows store identical samples.
See [why BCI teams bounce](ADOPTION.md) for the full tradeoff.

Markers, package counters and battery rows are retained as events and auxiliary tensors. A
backwards timestamp starts a new segment with an explicit gap; a discontinuity records a gap
whose lost-sample count stays **unknown** rather than being estimated.

## Honest limits

- Only the synthetic board and local file formats are exercised by the test suite. No physical
  device, firmware or electrode montage is verified here.
- Timestamp semantics differ per board. BrainFlow timestamps can be host receipt time; declare
  the clock domain you actually have and verify counters and reference against vendor software.
- Units are never inferred. A board or file without explicit units is rejected.
- A BrainFlow version older than the descriptor path you need cannot describe those boards; the
  catalog reports that instead of guessing.
