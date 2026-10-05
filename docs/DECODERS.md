# Decoders and EEG-to-text

A decoder turns recorded epochs into labels or text. ChronoDB records decoder lineage; it does
not run your model in the hosted database process and never downloads weights.

## The adapter interface

`sdk/python/chronograph_connectors/decoders/` defines one protocol. Anything that implements it
is a decoder, including models written outside this repository.

```python
from chronograph_connectors.decoders import decoder, decoders, register_decoder

print([d["name"] for d in decoders()])   # csp-lda-v1, eeg2text-v1, plus any plugin
```

| Member | Meaning |
| --- | --- |
| `manifest()` | name, version, kind (`classification` or `text`), required channels, rate, window, vocabulary, weights hash, runtime, limits |
| `fit(epochs, labels, groups, seed)` | Train on `(epochs, channels, samples)` float32. `groups` are participants or sessions and are used only for splitting |
| `predict(epochs)` | One result per epoch: label or text, probability, tokens, and an explicit `abstained` flag |
| `check_compatible(...)` | Compares required channels and rate with the dataset **before** any prediction |

Third-party decoders register through the `chronograph.decoders` entry-point group. A broken
entry point is reported as an error record by `describe_all()` instead of breaking the registry.

A plugin manifest must declare `required_channels`, `sample_rate_hz`, `vocabulary`,
`weights_sha256`, its own `encoder` and its `runtime`. A mismatch fails immediately and names the
difference, so a 128-channel research model and an 8-channel recording never silently disagree.

## Running a decoder in the browser

The console serves the module and one reference artifact, so a web application decodes through the
same reader as Python, the CLI and Rust instead of reimplementing the arithmetic:

| File | What it is |
| --- | --- |
| `/wasm/chronograph-decoder.wasm` | the module built from `crates/chronograph-wasm` (272,620 bytes) |
| `/wasm/artifact/model.json` | the artifact document: adapter, channels, rate, window, vocabulary, limits |
| `/wasm/artifact/weights.bin` | the tensors, addressed by byte range |

```js
import { Decoder } from "@chronograph-community/sdk";

const module = await WebAssembly.compile(
  await (await fetch("/wasm/chronograph-decoder.wasm")).arrayBuffer(),
);
const decoder = await Decoder.load(
  module,                                        // compile once, reuse per artifact
  await (await fetch("/wasm/artifact/model.json")).bytes(),
  await (await fetch("/wasm/artifact/weights.bin")).bytes(),
);
decoder.describe().channel_names;                // ["Fz","Cz","Pz","Oz","C3","C4","P3","P4"]
decoder.decode(windowBytes);                     // raw little-endian f64 samples
decoder.dispose();
```

`sdk/typescript/test/decoder.mjs` decodes those exact shipped files and compares every probability
with Python's output for the same windows; the largest difference measured is 1.1e-16. The shipped
artifact is a synthetic band-coded fixture fitted by `scripts/export-browser-decoder.py`: it exists
to make the browser path checkable, and it is not a model claim.

## The reference EEG-to-text decoder

`eeg2text-v1` is a deliberate, reproducible reference implementation. It is **not** SENSE,
NeuroNarrator or EEG2Text and does not claim their results: those need specific channel counts,
closed vocabularies and large upstream weights that cannot be reproduced or verified here.

- Features are single-frequency band powers: a symmetric Hann taper then a direct
  single-bin transform, accumulated in float64. There is no filter design to diverge between
  runtimes, so Python and the Rust executor compute the same table. The taper is symmetric, so a
  feature uses its whole window and is not causal sample-by-sample; an epoch must be complete
  before it is decoded. Epoch selection itself only ever uses past data.
- The vocabulary is a file. The default is a small command vocabulary
  (`up, down, left, right, stop, yes, no, select, help`) and it is swappable.
- `fit` uses deterministic one-hot ridge least squares, so a rerun reproduces the same weights.
- Decoding is greedy per token slot with a per-token probability and an abstention threshold.
  A below-threshold slot returns `<abstain>` rather than a guess, and the confidence printed with
  each token is explicitly uncalibrated, so you choose the threshold from measured coverage
  rather than assuming the number is a probability of being correct.
- Splitting, epoch rejection and preprocessing follow the existing baseline: participant groups
  when at least three participants exist, otherwise independent sessions; nonfinite samples,
  irregular timing, gap-crossing and artifact epochs are excluded; fitting uses training epochs only.

`csp-lda-v1` exposes the existing CSP and shrinkage-LDA baseline through the same interface with
unchanged behaviour, so both a classical and a text decoder are selectable with one call.

## Portable artifacts

`decoder-v1` is a directory holding `model.json` and `weights.bin`: little-endian, row-major
tensors at recorded offsets, each with its own SHA-256. Loading verifies the format, every offset,
every length and every digest, and rejects truncation or corruption. No pickle is ever executed,
and legacy `weights.npz` models still load.

`crates/chronograph-decoder` reads that artifact and runs the same feature extraction, linear
layer, softmax and vocabulary decode. It depends only on `serde`, `serde_json`, `sha2` and
`thiserror`, so it is built for a static target with:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl -p chronograph-decoder --bins
```

Status: the executor is implemented, tested and run in the parity check below, but the static
musl artifact itself was **not** produced in this environment (that target is not installed here,
and adding it needs network access). Treat the static build as an unverified packaging step.

Python and Rust are held to the same numbers by `scripts/bci-parity-test.py`, so a decoder
trained on a workstation runs unchanged where Python is unavailable. Measured on that fixture:
8 windows, identical tokens in both runtimes, and a largest probability difference of 3.3e-16
against a 1e-9 tolerance. The trigonometric tables come from each platform's libm, so this is a
tight tolerance rather than bit-identical arithmetic.

## What you can call today

| Surface | Call | Purpose |
| --- | --- | --- |
| Python registry | `decoders()`, `decoder(name)`, `describe_all()` | List every adapter and its manifest, including broken plugins |
| Python adapter | `adapter.manifest()`, `fit(epochs, labels, groups)`, `predict(epochs)` | Train and decode in process |
| Python text decoder | `EEG2TextDecoder.save(directory)` / `.load(directory)` / `.predict_windows(windows)` | Persist and rerun a portable artifact |
| Python artifact | `portable.save_artifact` / `load_artifact` / `run_artifact` | Write, verify and execute a `decoder-v1` directory |
| Static executor | `chronograph-decode --artifact DIR --describe` | Print adapter, geometry and limits without Python |
| Static executor | `chronograph-decode --artifact DIR --input window.f32` | Decode one window and print JSON |

Lineage uses the records that already exist: publish an immutable `run` record and one
`prediction` record per result, with the adapter name and version, weights digest, dataset,
branch, vocabulary and threshold in its fields. `bci_causal_path` then walks from any prediction
back through its run, dataset, sessions, streams and signal chunks.

Not implemented in this change, and deliberately not claimed: dedicated server-side
`decoder_*` operations, a `chronograph-bci decoders` CLI subcommand, a browser panel, a WASM
decoder binding, and any calibration helper beyond the abstention sweep documented above.
Confidence is reported per token and is explicitly uncalibrated.

## Branch a decode

Recording into a branch uses the same writer as the parent, so trying a different result never
needs a second writer:

```python
fork = client.call("fork", {"t": "0", "name": "decoder-b"})["fork"]["id"]
with BCISpool("./live-01", "bci_lsl", "live_01") as spool:
    spool.drain(client, fork=fork)
preview = client.call("preview_merge", {"fork": fork})
client.call("merge", {"fork": fork, "durability": "fsync"})
```

Reads accept `fork` too, so `bci_sessions`, `bci_records`, `bci_window`, `bci_manifest` and
`bci_causal_path` can inspect a branch without touching the parent. A branch inherits the state
it was forked from and isolates everything written afterwards.

## Limits

- Closed vocabulary output only. There is no open-vocabulary or free-form generation claim.
- Greedy per-slot decoding, not a sequence model with beam search or language-model rescoring.
- Scores on synthetic data verify plumbing, not generalization to people or devices.
- Decoding is a monitor. It is not a medical device, a clinical interpretation or a communication
  aid, and it must not drive actuation without your own safety analysis.
