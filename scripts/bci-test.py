"""Session -> offline spool -> durable graph -> dataset -> CPU decoder -> replay."""

from pathlib import Path
import json
import tempfile
import numpy as np
from bci_support import Service
from chronograph_connectors import Client, ApiError
from chronograph_connectors.bci import Session, BCIClient, initialize, save_dataset
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import synthetic, recorded_file
from chronograph_connectors.bci_training import train, predict

service = Service()
try:
    c = service.client
    initialize(c, clock_domain="simulation_us")
    bci = BCIClient(c)
    ids = []
    spools = []
    sessions = []
    for n in range(3):
        spool = BCISpool(service.root / f"spool{n}", "bci_research", f"capture{n}")
        session = Session(
            spool,
            clock_domain="simulation_us",
            name=f"Synthetic session {n + 1}",
            session_id=str(100 + n),
            start_us=0,
        )
        synthetic(session, seconds=48, seed=42 + n)
        assert spool.status()["pending_batches"] > 0
        spool.drain(c, max_batches=2000)
        ids.append(session.id)
        spools.append(spool)
        sessions.append(session)
    assert len(list(bci.sessions())) == 3
    rows = list(bci.records(ids[0], record_type="signal"))
    assert len(rows) == 194
    r = rows[0]["record"]
    assert bci.tensor(r["assets"]["signal"]).shape == (8, 62)
    win = bci.window(ids[0], "eeg", 0, 10_000_000, channels=[0, 1])
    assert len(win["channels"]) == 2 and win["display_only"]
    try:
        c.call(
            "bci_window",
            {
                "instance": "bci_research",
                "session": ids[0],
                "stream": "eeg",
                "start": "0",
                "end": "999999999",
            },
        )
    except ApiError as e:
        assert e.status == 400
    else:
        raise AssertionError("Unbounded window accepted")
    reader = (
        c.call("create_token", {})
        if False
        else json.loads(
            c.request(
                "/v1/tokens", body={"name": "BCI reader", "scope": "read", "days": 1}
            )
        )
    )
    readonly = Client(service.url, reader["token"])
    assert readonly.call("bci_sessions", {})["sessions"]
    try:
        readonly.call(
            "connector_ingest",
            {
                "instance": "bci_research",
                "partition": "denied",
                "sequence": "0",
                "records": [r],
            },
        )
    except ApiError as e:
        assert e.status == 403
    else:
        raise AssertionError("Read key wrote data")
    try:
        c.call(
            "connector_ingest",
            {
                "instance": "bci_research",
                "partition": "overwrite",
                "sequence": "0",
                "records": [r],
            },
        )
    except ApiError as e:
        assert e.status == 409
    else:
        raise AssertionError("Replaced immutable recording")
    manifest = c.call(
        "bci_manifest", {"instance": "bci_research", "sessions": ids, "stream": "eeg"}
    )["manifest"]
    for mutation in ("instance", "duplicate", "hash"):
        invalid = json.loads(json.dumps(manifest))
        if mutation == "instance":
            invalid["instance"] = "another_binding"
        elif mutation == "duplicate":
            invalid["sessions"][1] = invalid["sessions"][0]
        else:
            invalid["source_snapshots"][0]["sha256"] = "not-a-hash"
        bad = sessions[0].record("dataset", 0, name="Invalid fixture", manifest=invalid)
        try:
            c.call(
                "connector_ingest",
                {
                    "instance": "bci_research",
                    "partition": "invalid_dataset",
                    "sequence": "0",
                    "records": [bad],
                },
            )
        except ApiError as error:
            assert error.status == 400
        else:
            raise AssertionError("Malformed dataset manifest accepted")
    did = save_dataset(c, sessions[0], "Synthetic baseline", manifest, spool=spools[0])
    spools[0].drain(c)
    results = []
    for components in [2, 4]:
        out = service.root / f"model-{components}"
        result = train(bci, manifest, out, dataset_id=did, components=components)
        assert result["train_epochs"] > 0 and result["test_epochs"] > 0
        results.append(result)
        record = sessions[0].record(
            "run",
            0,
            name=f"CSP {components}",
            dataset_id=did,
            recipe=result["recipe"],
            status="succeeded",
            result=result,
        )
        spools[0].enqueue([record])
        spools[0].drain(c)
    prediction = predict(
        service.root / "model-4", np.random.default_rng(1).normal(0, 1e-6, (8, 500))
    )
    assert 0 <= prediction["probability"] <= 1
    heldout = np.concatenate(
        [data for _, data, _ in bci.chunks(ids[-1], "eeg")], axis=1
    )
    for start, label in [(125, "left"), (1125, "right")]:
        assert (
            predict(service.root / "model-4", heldout[:, start : start + 500])["label"]
            == label
        )
    import base64
    from chronograph_connectors.bci_training import unpack_managed_result

    bundle = {
        "status": "succeeded",
        "metrics": results[-1],
        "artifact": {
            "model": results[-1]["model"],
            "weights_base64": base64.b64encode(
                (service.root / "model-4" / "weights.npz").read_bytes()
            ).decode(),
        },
    }
    (service.root / "job.json").write_text(json.dumps(bundle))
    unpack_managed_result(service.root / "job.json", service.root / "restored-model")
    assert (
        predict(service.root / "restored-model", heldout[:, 125:625])["label"] == "left"
    )
    sessions[0].prediction("eeg", 0, 2_000_000, run_id=record["dst"], **prediction)
    spools[0].drain(c)
    assert len(list(bci.records(ids[0], record_type="run"))) == 2
    # Appends do not alter a frozen dataset. New annotation is outside its cutoff.
    sessions[0].event("eeg", 1000000, "Review", category="note")
    spools[0].drain(c)
    frozen = c.call(
        "bci_manifest",
        {
            "instance": "bci_research",
            "sessions": ids,
            "stream": "eeg",
            "cutoffs": {
                s["session"]: s["through_edge"] for s in manifest["source_snapshots"]
            },
        },
    )["manifest"]
    assert frozen == manifest
    exported = bci.export(ids[0], "eeg", service.root / "export")
    original = bci.tensor(r["assets"]["signal"])
    with np.load(
        service.root / "export" / exported["chunks"][0]["file"], allow_pickle=False
    ) as data:
        assert data["signal"].tobytes() == original.tobytes()
    from chronograph_connectors.bci_export import fif, bids

    fif(service.root / "export", service.root / "export_raw.fif")
    bids(
        service.root / "export",
        service.root / "bids",
        subject="synthetic01",
        task="motorimagery",
    )
    assert list((service.root / "bids").glob("sub-*/eeg/*_eeg.vhdr"))
    # Recorded FIF preserves voltage units and source samples.
    import mne

    raw = mne.io.RawArray(
        np.arange(1000, dtype=float).reshape(2, 500) * 1e-6,
        mne.create_info(["C3", "C4"], 250, ["eeg", "eeg"]),
        verbose="ERROR",
    )
    raw.set_annotations(mne.Annotations([0.1, 0.5], [0.2, 0.4], ["cue", "BAD_motion"]))
    raw.save(service.root / "input_raw.fif", fmt="double", verbose="ERROR")
    with BCISpool(service.root / "file-spool", "bci_research", "file") as q:
        file_session = Session(q, clock_domain="simulation_us", source="fif")
        recorded_file(file_session, service.root / "input_raw.fif", start_us=0)
        q.drain(c)
        first = next(bci.chunks(file_session.id, "eeg"))
        np.testing.assert_array_equal(first[1], raw.get_data())
        events = list(bci.records(file_session.id, record_type="event"))
        artifact = next(
            e["record"]
            for e in events
            if e["record"]["fields"]["category"] == "artifact"
        )
        assert (
            int(artifact["fields"]["end_us"]) - int(artifact["timestamp_us"]) == 400000
        )
    exported_raw = mne.io.read_raw_fif(
        service.root / "export_raw.fif", preload=True, verbose="ERROR"
    )
    np.testing.assert_array_equal(
        exported_raw.get_data(),
        np.concatenate([v for _, v, _ in bci.chunks(ids[0], "eeg")], axis=1),
    )
    before = c.call("stats")
    service.stop(crash=True)
    service.start()
    assert c.call("stats")["edge_versions"] == before["edge_versions"]
    assert bci.window(ids[0], "eeg", 0, 1_000_000)["channels"]
    assert list(bci.records(ids[0], record_type="prediction"))
    for q in spools:
        q.close()
    print(
        json.dumps(
            {
                "passed": True,
                "sessions": len(list(bci.sessions())),
                "signal_chunks": len(rows),
                "decoder_runs": len(results),
                "balanced_accuracy_fixture": [r["balanced_accuracy"] for r in results],
                "prediction": prediction,
                "durability": "fsync + forced restart",
                "source": "synthetic + recorded FIF; not hardware or model-quality qualification",
            }
        )
    )
finally:
    service.close()
