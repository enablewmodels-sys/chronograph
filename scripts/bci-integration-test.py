"""Adoption-critical plumbing: MNE interop, honest gap refusal, and the real
cost of a durable commit for a closed loop."""

import json
import time

import numpy as np
from bci_support import Service
from chronograph_connectors.bci import Session, BCIClient, initialize
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import synthetic

INSTANCE = "integration_research"
KIND = 441
RATE = 250
CHANNELS = 4
SECONDS = 8


def queue_rows(spool):
    return spool.db.execute("SELECT COUNT(*) FROM queue").fetchone()[0]


service = Service(port=18099, require_fsync=True)
try:
    client = service.client
    initialize(client, INSTANCE, KIND, "simulation_us")
    bci = BCIClient(client, INSTANCE)

    # --- Interop: a recording is an MNE object, not a bespoke format -------------
    with BCISpool(service.root / "mne", INSTANCE, "mne_run") as q:
        session = Session(
            q, source="synthetic", clock_domain="simulation_us", name="Interop recording"
        )
        synthetic(session, seconds=SECONDS, rate=RATE, channels=CHANNELS, seed=7)
        # The import path records a bad channel exactly this way, so the round trip
        # through MNE is exercised rather than asserted vacuously.
        session.event("eeg", 250_000, "EEG02", category="bad_channel", channel="EEG02")
        commits = queue_rows(q)
        began = time.monotonic()
        assert q.drain(client) > 0
        elapsed = time.monotonic() - began
        session_id = session.id

    raw = bci.to_mne(session_id)
    samples = int(raw.get_data().shape[1])
    assert raw.info["sfreq"] == float(RATE), raw.info["sfreq"]
    assert raw.ch_names == ["EEG01", "EEG02", "EEG03", "EEG04"], raw.ch_names
    assert raw.get_data().shape == (CHANNELS, SECONDS * RATE), raw.get_data().shape
    assert raw.info["description"] == "Interop recording", raw.info["description"]
    assert raw.info["bads"] == ["EEG02"], raw.info["bads"]
    labels = sorted(set(raw.annotations.description))
    assert {"left", "right"} <= set(labels), labels
    onsets = sorted(round(float(value), 3) for value in raw.annotations.onset)
    assert {0.0, 4.0} <= set(onsets), onsets
    # Nothing was resampled, filtered or rescaled on the way into MNE.
    stored = sum(chunk[1].shape[1] for chunk in bci.chunks(session_id, "eeg"))
    assert stored == samples, (stored, samples)

    # A recording with an explicit gap is refused rather than silently joined.
    with BCISpool(service.root / "gap", INSTANCE, "gap_run") as q:
        gapped = Session(q, source="synthetic", clock_domain="simulation_us")
        synthetic(gapped, seconds=2, rate=RATE, channels=CHANNELS, seed=8)
        gapped.gap("eeg", 500_000, 700_000, reason="probe detached", lost_samples=None)
        assert q.drain(client) > 0
        gapped_id = gapped.id
    try:
        bci.to_mne(gapped_id)
        raise AssertionError("a recording with a gap must not convert to Raw")
    except ValueError as error:
        assert "gap" in str(error), str(error)

    # --- The real closed-loop budget: commits, not samples ----------------------
    # Every acknowledged batch is one synchronized commit, and ingestion always
    # synchronizes before it acknowledges. The lever is therefore samples per record.
    per_commit_ms = elapsed * 1000.0 / commits
    duty_cycle = 100.0 * elapsed / SECONDS
    assert 0.0 < duty_cycle < 100.0, duty_cycle

    def budget(tag, chunk_samples):
        with BCISpool(service.root / tag, INSTANCE, tag) as q:
            run = Session(q, source="synthetic", clock_domain="simulation_us")
            synthetic(
                run,
                seconds=SECONDS,
                rate=RATE,
                channels=CHANNELS,
                seed=11,
                chunk_samples=chunk_samples,
            )
            pending = queue_rows(q)
            began = time.monotonic()
            assert q.drain(client) > 0
            took = time.monotonic() - began
            parts = [chunk[1] for chunk in bci.chunks(run.id, "eeg")]
            return run.id, pending, took, np.concatenate(parts, axis=1)

    default_id, default_commits, default_seconds, default_samples = budget(
        "budget_default", None
    )
    tuned_id, tuned_commits, tuned_seconds, tuned_samples = budget("budget_tuned", 500)
    # The samples themselves must be identical: only the commit count may change.
    assert default_samples.shape == tuned_samples.shape == (CHANNELS, SECONDS * RATE)
    assert np.array_equal(default_samples, tuned_samples), float(
        np.max(np.abs(default_samples - tuned_samples))
    )
    assert tuned_commits * 3 < default_commits, (tuned_commits, default_commits)
    speedup = default_seconds / tuned_seconds
    assert speedup > 2.0, speedup
    tuned_duty = 100.0 * tuned_seconds / SECONDS

    print(
        json.dumps(
            {
                "passed": True,
                "mne_channels": len(raw.ch_names),
                "mne_samples": samples,
                "mne_annotations": labels,
                "mne_onsets_s": onsets,
                "gap_recording_refused": True,
                "durable_commits": commits,
                "ms_per_commit": round(per_commit_ms, 2),
                "recording_duty_cycle_pct": round(duty_cycle, 2),
                "default_commit_budget_chunks": default_commits,
                "tuned_commit_budget_chunks": tuned_commits,
                "samples_stored_both": int(tuned_samples.shape[1]),
                "samples_identical_across_budgets": True,
                "commit_reduction_x": round(default_seconds / tuned_seconds, 2),
                "tuned_duty_cycle_pct": round(tuned_duty, 2),
                "sessions": [session_id, gapped_id, default_id, tuned_id],
                "note": "synthetic data on one host; interop and plumbing only",
            }
        )
    )
finally:
    service.close()