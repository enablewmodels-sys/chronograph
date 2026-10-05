# Why BCI teams bounce, and what was done about it

This page is written for the person who has to convince a lab, a study or a robot
team to put their neural data somewhere new. It states the blockers plainly, gives the
measured numbers, and separates what is fixed here from what is still a gap.

Numbers marked *measured* come from `scripts/bci-integration-test.py` on one host
(Apple silicon, local loopback, 250 Hz, 4 channels, synthetic data). They are plumbing
figures, not performance guarantees for another machine.

## The seven reasons a BCI team says no

| # | The objection, in their words | Why it is fatal | What this repository does now |
| --- | --- | --- | --- |
| 1 | "My pipeline is MNE. I am not rewriting it." | A storage product that does not hand back a `Raw` is a dead end on day one | `BCIClient.to_mne(session)` returns an `mne.io.RawArray` with the recorded channel names, types, units, rate, annotations and bad channels. Verified byte-exact against the stored chunks, including the bad-channel round trip. Nothing is resampled, filtered or rescaled. It is not a time machine: `raw.info["meas_date"]` stays unset, because a recording clock domain is not necessarily calendar time |
| 2 | "We already stream over LSL. Do not make me change the rig." | Labs will not swap their acquisition stack for a database | LSL is a first-class source next to BrainFlow, and the synthetic board needs no hardware at all |
| 3 | "A closed loop cannot wait for a disk write." | True, and it is the objection with real teeth: ingestion always synchronizes before it acknowledges | Measured on the synthetic path: **33.7 ms per durable commit** at the default 62-sample budget, a 15.6% duty cycle for one 250 Hz stream. Raising the budget to 500 samples per record cut 37 commits to 8 and total time **6.0x**, storing exactly the same 2000 samples. The knob is samples per record, exposed as `chunk_samples` (synthetic, files) and `pull_samples` (LSL) |
| 4 | "Our lab runs four recordings at once." | A single-writer engine looks like a bottleneck to anyone with a shared workstation | Writers are single by design for a reason that matters more here than throughput: one writer per workspace is what makes replay and a branch meaningful. Many producers share one spool, and a measured 4 producers x 50 enqueues produced 200 contiguous queue rows in 0.18 s with no lock errors; one drainer then serializes them, so throughput is bounded at roughly 30 commits/s per workspace (about 7 concurrent 250 Hz streams at the default budget, about 30 at a 500-sample budget). `Graph::apply_fork_batch` commits several branches in one frame and one synchronization, but it is an embedded Rust API with **no HTTP or MCP caller yet**. There is still **no multi-process writer**, and that is a stated limit, not a hidden one |
| 5 | "Our IRB will not sign off on a third-party cloud." | Human neural data carries consent, retention and jurisdiction obligations | Local-first: record, store and decode on your own machine. Nothing leaves it unless you point the client at a remote origin, and the same contracts run in an isolated deployment |
| 6 | "We need BIDS or NWB, or it is not a dataset." | Publishing and funding both require a standard | Exact NumPy chunks, continuous FIF and EEG-BIDS derivation exist and keep the original alongside. **NWB export is not implemented.** The exact-source export is what makes a derivative defensible, and the official BIDS validator still has to be run by you |
| 7 | "New database means lock-in." | A journal they cannot read is a risk to a five-year study | The journal format is documented frame by frame, every record is recovered or explicitly rejected rather than skipped, and the whole recording exports to plain NumPy. The decoder artifact is a documented `model.json` plus little-endian `weights.bin` |

## What "dream come true" means concretely

The path from nothing to a researcher's own tooling is three commands and no infrastructure:

```sh
pip install './sdk/python[bci]'
chronograph-bci synthetic --seconds 60 --rate 250 --channels 8 --spool ./rec --sync
```

```python
from chronograph_connectors.bci import BCIClient

raw = BCIClient(client, "bci_research").to_mne("101")   # their own MNE pipeline, unchanged
raw.filter(8, 30).plot()
```

Everything after that is the part a plain file cannot do:

- **Replay the decision, not just the signal.** `as_of(T)` shows what the system knew at
  the moment it acted, because every relationship carries a validity interval.
- **Try the other decoder without losing the first.** A decode into a branch is isolated
  until it is merged, and `preview_merge` shows the mappings before anything is published.
- **Walk from an action back to the electrode.** `bci_causal_path` starts at a prediction
  and follows run, dataset, sessions, streams and the exact chunks that produced it.
- **Drive a robot from it.** A decoded command becomes an action record on the same
  timeline as the signal that caused it, so a robot run is explainable after the fact
  rather than only observable in the moment.

## Where it is still honest-to-goodness weak

These are the gaps this work does not close, stated so nobody discovers them in a demo:

- **No physical-board claim.** Every board is *described* from your installed BrainFlow
  driver; only the synthetic board and local files are exercised by the tests.
- **No real-time guarantee.** 33.7 ms per durable commit is a local measurement. A control
  loop must keep its fast path in memory; the database trails it. Do not put ingestion on
  the critical path of a stimulation or robot-safety loop.
- **No NWB, no XDF writer, no BIDS validator run.**
- **No multi-process writer, no row-level authorization, no per-user quotas.**
- **No clinical status, no regulated-health hosting, no store submissions.**
- **The EEG-to-text decoder is a closed-vocabulary reference**, not SENSE, NeuroNarrator or
  EEG2Text, and it makes no accuracy claim beyond its synthetic plumbing check.

## The workaround pattern, in one line each

- Interop first: hand back the object the researcher already uses (`to_mne`).
- Record where they already work: accept LSL and every BrainFlow board rather than replacing them.
- Pay for commits, not samples: raise samples per record instead of weakening durability.
- One writer per workspace, many producers per writer: one spool and one drainer.
- Rehearse before publishing: branch the decode, preview the merge, then commit.
- Prove the format, do not promise it: export everything to plain NumPy.
