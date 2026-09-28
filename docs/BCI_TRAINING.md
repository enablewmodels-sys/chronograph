# BCI datasets, decoders and workers

ChronoDB supplies a reproducible EEG baseline and records its lineage. It is not a
claim of decoder suitability for a participant, clinical outcome or physical device.
Start with the [recording guide](BCI.md). Run all acquisition and local training on
your own laptop/workstation, not inside the hosted database process.

## Freeze the input

Record at least **three independent sessions** with the same channel order, units,
reference and sample rate. Each session should contain both `left` and `right` cue
labels, with enough clean trials for the split. Synthetic 48-second sessions create
12 alternating cues; use distinct seeds and spool/partition names. In the UI select
sessions in **BCI → Datasets**, then **Save & download manifest**.

Or use the SDK/CLI with an existing recording spool and an ingest key:

```sh
chronograph-bci dataset --token-file ./ingest.token \
  --instance bci_research --clock-domain simulation_us \
  --spool ./recording-01 --partition recording_01 \
  --sessions 101,102,103 --name 'Synthetic baseline' --output ./dataset.json
```

Keep the returned `dataset_id`. The manifest freezes each session at a specific
append edge and hashes its original metadata, stream, signals, events, gaps and
clock records. Later annotations do not silently alter an existing dataset. Create
a new manifest to include corrections or exclusions. Training recomputes the
cutoff hashes and rejects mismatched source data.

## Run and compare a CPU baseline

```sh
chronograph-bci train --token-file ./read.token \
  --input ./dataset.json --dataset-id YOUR_DATASET_ID \
  --components 4 --output ./decoder-csp4
chronograph-bci train --token-file ./read.token \
  --input ./dataset.json --dataset-id YOUR_DATASET_ID \
  --components 2 --output ./decoder-csp2
```

The built-in `csp-lda-v1` pipeline uses explicit voltage scaling, a causal 8–30 Hz
Butterworth filter, cue-relative 0.5–2.5-second epochs, MNE CSP with shrinkage, and
scikit-learn shrinkage LDA. It excludes nonfinite samples, irregular timing and
epochs crossing gaps or marked artifact/bad-channel spans. It requires at least
four epochs and both classes in each split. Input is bounded to 128 MiB for this
baseline; larger/custom training belongs in your own worker.

Splits use participants when at least three distinct participants exist, otherwise
independent sessions. A deterministic held-out group split keeps overlapping chunks
from the same recording out of opposite sides. CSP and classification fit only on
training epochs. The result includes split assignments, rejected-epoch counts,
balanced accuracy, confusion matrix, dependency versions and source provenance.
Synthetic scores test the plumbing; they do not measure generalization to real EEG.

Each output directory contains `result.json`, `model.json` and `weights.npz`.
Models use bounded, hashed NumPy arrays with `allow_pickle=False`; no arbitrary
pickle execution is required. Keep the files together. To publish a completed run
in your recording's **Runs** tab, supply its existing spool/partition and an ingest
key with `--sync` to `train`. The command in the workspace includes these arguments.
Do not accidentally create a new spool when publishing to an existing recording.

## Replay and live prediction

```sh
chronograph-bci predict --model ./decoder-csp4 --input ./epoch.npy
chronograph-bci decode --token-file ./ingest.token \
  --model ./decoder-csp4 --run-id YOUR_PUBLISHED_RUN_ID \
  --instance bci_lsl --clock-domain lsl_local_us \
  --source-id YOUR_LSL_SOURCE_ID \
  --channels EEG01,EEG02,EEG03,EEG04,EEG05,EEG06,EEG07,EEG08 --units V \
  --spool ./live-01 --partition live_01 --seconds 60 --sync
```

Supply `--reference` with the reference stored in `model.json`. The live channel
order, units, reference and rate must match the model. Sliding windows run the
same preprocessing; irregular windows are rejected. Predictions include the run ID,
label, probability and measured local inference time. The UI refreshes every two
seconds; it is a monitor, not a hard-realtime control loop. Your application remains
responsible for actuation, feedback timing and safety. Publish feedback as explicit
`Session.event(..., category='feedback')` records or through your own adapter.

## Managed worker boundary

The hosted database currently exposes job controls but reports **separate compute
required**. No training is scheduled on its small production instance and no new
compute spend is enabled by this release. Local workers remain usable immediately.

Managed operators can connect a separately provisioned CPU worker. The private
control plane persists a project-scoped SQLite queue with idempotency keys, two
pending jobs per project, ten submissions/day, one concurrent job, 60-second leases,
three attempts and a 15-minute attempt limit. Owners/admins/editors may submit or
cancel; viewers can inspect their project's results. All requests require the
existing authenticated project session and MFA policy.

The worker gets a job-scoped broker, never a project API key. It materializes only
the frozen sessions/assets into a bounded input directory. The built-in recipe runs
in a non-root OCI container with no network, a read-only root, dropped capabilities,
1 CPU, 768 MiB memory and 64 processes. Only input/output directories are mounted.
The operator pins an immutable local image ID; arbitrary customer code/images are
not accepted. Cancellation revokes the lease and removes the container on the next
heartbeat. Output is bounded and retained as a downloadable result/model bundle. Restore the
JSON download locally with `chronograph-bci unpack-model --input job.json --output
./managed-decoder`, then use the same `predict` or `decode` commands.

The UI queues saved datasets only when an operator has configured this separate
worker. Queued/running/failed/cancelled/succeeded states persist across gateway
restarts. An enabled queue without an online worker will remain queued; operators
must monitor worker availability and storage.

For other architectures (deep EEG networks, world models, Jev/Laya), train in your
own environment and publish metrics and artifact references with explicit dataset
and run lineage. ChronoDB does not automatically train an arbitrary model merely
because a connector exists.
