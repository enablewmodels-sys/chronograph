# BCI recording and research workspace

ChronoDB connects EEG recordings, experimental events, datasets and decoder history.
The database is independent infrastructure for teams building brain–computer
interfaces, including alternatives to Neuralink. There is no Neuralink affiliation,
implant interface, clinical certification or safety-critical device control.

[Download the starter archive](https://chronodb.co/downloads/chronodb-bci-examples.zip) or
[offline notebook](https://chronodb.co/downloads/eeg-research.ipynb). Checksums: [manifest](https://chronodb.co/downloads/bci-manifest.json).

Try the [interactive synthetic recording](https://chronodb.co/bci), then open **BCI workspace** in your
console. The same recording contract and SDK work in Managed and isolated Community
installations. Jev, Laya, robotics and world-model connectors remain available.
The EEG baseline is tested with Python 3.12; the base HTTP client still supports
Python 3.10+.

## What is included

| Workflow | Implementation |
| --- | --- |
| Acquisition | Local Python agent: synthetic EEG, BrainFlow, LSL, EDF/BDF/FIF |
| Offline operation | Private durable SQLite spool, resumable asset uploads and exact receipt retries |
| Replay | Time-window waveform envelopes, channels, experimental cues, gaps and annotations |
| Datasets | Immutable session cutoffs and source hashes; JSON manifests |
| Training | Actual MNE CSP + scikit-learn shrinkage LDA on a local CPU; bounded optional Managed worker |
| Comparison | Per-run dataset lineage, held-out balanced accuracy and confusion matrix |
| Live feedback | LSL predictions and application feedback recorded alongside signals |
| Export | Exact NumPy chunks, continuous MNE FIF, optional EEG-BIDS/BrainVision derivative |

Synthetic and recorded-file fixtures are tested. Physical devices require an
acquisition check on the exact board, firmware, channels, reference and timing
configuration. No hardware compatibility or real-subject decoder score is implied.

## Start with synthetic data

Build a recent Community checkout following [local setup](QUICKSTART.md), or create
a project on [chronodb.co](https://chronodb.co). These BCI changes are on `main`;
the older alpha.2 release does not contain them. Install from the checkout:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install './sdk/python[bci]'
export CHRONOGRAPH_URL=http://127.0.0.1:8080
```

For Managed set `CHRONOGRAPH_URL=https://chronodb.co`. Create a scoped project key
in **Access**. Save it in a private local file (mode 0600) and supply `--token-file`.
Use an **admin** key to create a binding; use **ingest** for recording and **read**
for replay/export/training. Never put credentials into a notebook, migration,
source-control repository or acquisition metadata. Managed browser authentication
uses GitHub/Google or an invited email account; a browser session is not an SDK key.

```sh
chronograph-bci init --token-file ./admin.token \
  --instance bci_research --kind 430 --clock-domain simulation_us
chronograph-bci synthetic --token-file ./ingest.token \
  --instance bci_research --clock-domain simulation_us \
  --spool ./recording-01 --partition recording_01 \
  --session 101 --participant synthetic01 --start-us 0 \
  --seconds 48 --rate 250 --realtime --sync
chronograph-bci sessions --token-file ./read.token --instance bci_research
```

Choose an unused relation kind for each binding. **Connect recording** generates,
previews and applies the migration in the UI. Connector dropdown: **BCI research /
research-v1**. Existing BrainFlow, LSL and generic neural contracts are unchanged;
the new workspace indexes `bci/research-v1` records only.

Open `/app/bci`, select the recording, change the window or channels, and replay.
An ingest/admin credential can annotate the visible window as a cue, artifact,
bad-channel span, feedback or note. Annotations append records; raw samples do not
change. Select several recordings under **Datasets** to save a frozen manifest.
The [decoder guide](BCI_TRAINING.md) explains training and live predictions.

## Capture on the acquisition machine

The acquisition agent currently targets Linux and macOS (POSIX file locking).
Install device dependencies only on that machine:

```sh
pip install './sdk/python[bci,bci-hardware]'
```

BrainFlow's synthetic board is `-1`; real board IDs and connection settings come
from your board's BrainFlow documentation. Use a new spool/partition for a new
recording. `unix_us` is appropriate for its Unix timestamp channel, but this may
represent host receipt time rather than electrode sampling time. Select the preset
explicitly and declare the original board units; no implicit microvolt conversion.

```sh
chronograph-bci brainflow --token-file ./ingest.token \
  --instance bci_unix --clock-domain unix_us \
  --board-id -1 --preset 0 --units uV --seconds 60 \
  --spool ./board-01 --partition board_01 --sync
```

Create `bci_unix` first using an unused kind and `unix_us`. Supply a private
`--board-config connection.json` for real device parameters. The agent owns prepare,
start, stop and release. Markers and package-counter discontinuities are recorded;
timestamp gaps are explicit and unknown loss counts remain unknown. Verify the
sample counters and reference against your hardware acquisition software. Use
`--reference` to record the actual original reference. Omission stays explicitly
`unspecified` and prevents BIDS export; ChronoDB never guesses a reference.

For LSL, create a separate binding with `lsl_local_us` and a different kind:

```sh
chronograph-bci lsl --token-file ./ingest.token \
  --instance bci_lsl --clock-domain lsl_local_us \
  --source-id YOUR_UNIQUE_SOURCE_ID --channels C3,C4,Cz --units uV \
  --seconds 60 --spool ./lsl-01 --partition lsl_01 --sync
```

LSL runs on the local machine/network. Its clock is monotonic, not calendar time;
see the [LSL synchronization documentation](https://labstreaminglayer.readthedocs.io/info/time_synchronization.html). Raw source timestamps are kept separately
from the receiver's clock correction; they are never labelled Unix time. Channel
order, rate, units and reference must be verified against the outlet. ChronoDB
records clock measurements and reconnect gaps. It does not promise hard realtime
or submillisecond synchronization across arbitrary devices.

Recorded imports preserve selected voltage-channel values in SI volts, annotations
and bad channels through MNE. Keep the original file separately. Supply acquisition
start explicitly; use `simulation_us` and zero for relative recordings:

```sh
chronograph-bci import --token-file ./ingest.token \
  --instance bci_research --clock-domain simulation_us \
  --input ./experiment_raw.fif --start-us 0 \
  --spool ./file-01 --partition file_01 --sync
```

Non-voltage channels are not relabelled as volts. EDF/BDF conversion follows MNE's
reader; ChronoDB's exactness guarantee applies to the arrays received by its SDK,
not to a byte-for-byte reconstruction of a source file header.

## Offline operation and backpressure

The local spool contains sensitive recording data; protect it as carefully as the
database. It defaults to a 1 GiB pending-data quota and a 64 MiB disk reserve.
Signal tensors and record references commit in one SQLite transaction. The sender
uploads assets, freezes the exact record batch, then retains it until a matching
`fsync` receipt arrives. An acknowledgement lost during a disconnect can be retried
with the same sequence. Restart with the same spool, instance and partition.

```sh
chronograph-bci status --spool ./recording-01 --partition recording_01
chronograph-bci pause --spool ./recording-01 --partition recording_01
chronograph-bci resume --spool ./recording-01 --partition recording_01
chronograph-bci sync --token-file ./ingest.token \
  --spool ./recording-01 --partition recording_01
```

`pause` and `cancel` stop sending; they preserve queued records. Acquisition itself
stops with the process (Ctrl+C). On full storage/quota the agent stops with an
error instead of silently dropping or overwriting samples. Recover pending data
before restarting acquisition; device-side data produced while stopped cannot be
recovered by the database. One sender owns a spool at a time.

## Data contract and clocks

Session metadata identifies a pseudonymous participant, study, source and driver.
Streams fix channel names/order, types, units, nominal rate and reference. Signal
records reference immutable little-endian f32/f64 tensors `[channels, samples]`, an
f64 original timestamp vector, segment/sample indices and clock correction. NaN
and infinity bits are retained; waveform rendering omits them. There is no implicit
resampling, filtering or re-referencing on ingest. Segment IDs allow explicit
reconnects; sample ranges cannot overlap within one segment.

`clock_domain` is immutable per connector binding. `timestamp_us` and `end_us` use
that domain; original asset timestamps use seconds. Acquisition coverage is
`[timestamp_us, end_us)`. Event, gap, clock, prediction, dataset and run records
carry independent IDs. Their relationship history remains immutable. The journal
and verified assets are authoritative; the session index is rebuilt after restart.

## API, TypeScript and MCP

All read operations use `/v1/graph` or the matching scoped MCP tool. The existing
`asset_put`, `asset_get` and `connector_ingest` operations publish recordings.

| Operation | Main arguments | Result |
| --- | --- | --- |
| `bci_sessions` | optional instance, limit, after | Session page and next_cursor |
| `bci_session` | instance, session | Metadata, streams, timing, counts |
| `bci_records` | instance, session, record_type, stream, after, limit | Append-ordered page and cursor |
| `bci_window` | instance, session, stream, start, end, channels, points | Min/max envelope, events, coverage |
| `bci_manifest` | instance, sessions, stream, optional cutoffs | Frozen source hashes and recipe defaults |

IDs and microsecond times are decimal strings on the wire. Record pages are capped
at 500; advance the returned cursor even if a filtered page is empty. Windows are
limited to 60 seconds, 16 channels, 2048 display points, 64 MiB decoded data and 500
overlaid events. Display output is not an exact sample export. The derived BCI
index has a bounded metadata admission budget; archive/size your workspace rather
than assuming unlimited retention. Assets and native API limits still apply.

```ts
import { Client, BCIClient } from './sdk/typescript/dist/index.js';
// Configure Client using the SDK guide; keys stay on your application server.
const bci = new BCIClient(client, 'bci_research');
const window = await bci.window('101', 'eeg', 0n, 10000000n, [0, 1]);
```

See [SDK authentication](SDK.md), [API/OpenAPI](API.md) and [MCP setup](MCP.md).
Managed project isolation and read/ingest/admin scopes apply to these operations.
Agent access must be scoped to the project and minimum necessary data.

## Export and data handling

```sh
chronograph-bci export --token-file ./read.token --session 101 \
  --stream eeg --output ./exact-recording
chronograph-bci export --token-file ./read.token --session 101 \
  --format fif --output ./mne-recording
pip install './sdk/python[bci,bci-bids]'
chronograph-bci export --token-file ./read.token --session 101 \
  --format bids --subject synthetic01 --task motorimagery --output ./bids-recording
```

The NumPy export retains exact chunks, original timestamps, events, gaps, corrections
and file hashes. FIF/BIDS exports keep that exact source alongside the derivative.
They require continuous, regular voltage-channel data and an explicit reference;
recordings with gaps are rejected instead of interpolated. FIF uses double
precision. BrainVision uses float32 and can incur rounding. Run the official BIDS
validator and complete study-specific metadata before describing a dataset as
BIDS-valid. Participant identities, consent, coordinates and device approvals are
never invented.

Use pseudonymous identifiers and minimize sensitive metadata. Managed remains a
launch preview: no regulated-health hosting agreement or certification is implied.
Choose isolated deployment when organizational policy requires it. Scope keys,
protect local files, record participant consent outside the graph and define a
retention/export/closure process. Invalidation preserves history; it is not erasure.
See [data protection](https://chronodb.co/data-protection), [security](SECURITY.md) and
[production operations](PRODUCTION.md) for actual backup/deletion boundaries.
