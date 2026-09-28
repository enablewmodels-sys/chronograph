"""Real-time 64-channel/1kHz recording with an intentional transport outage."""

import argparse
import json
from pathlib import Path
import threading
import time
import numpy as np
from bci_support import Service
from chronograph_connectors.bci import initialize, Session, BCIClient
from chronograph_connectors.bci_spool import BCISpool

p = argparse.ArgumentParser()
p.add_argument("--seconds", type=int, default=3600)
p.add_argument("--offline-start", type=int, default=600)
p.add_argument("--offline-seconds", type=int, default=600)
p.add_argument("--report", default="/tmp/chronodb-bci-soak-report.json")
a = p.parse_args()
server = Service(18097)
q = None
stop = threading.Event()
errors = []
latencies = []
ingest = []
max_pending = 0
begin = time.monotonic()
try:
    c = server.client
    initialize(c, clock_domain="simulation_us")
    q = BCISpool(server.root / "queue", "bci_research", "soak")
    s = Session(
        q,
        clock_domain="simulation_us",
        session_id="64000",
        name="64-channel sustained fixture",
    )
    s.stream(
        "eeg",
        channels=[f"EEG{i}" for i in range(64)],
        units=["V"] * 64,
        sample_rate_hz=1000,
    )

    class Measured:
        def asset(self, *args, **kwargs):
            return c.asset(*args, **kwargs)

        def call(self, *args, **kwargs):
            t = time.perf_counter()
            r = c.call(*args, **kwargs)
            ingest.append((time.perf_counter() - t) * 1000)
            return r

    def sender():
        try:
            with BCISpool(server.root / "queue", "bci_research", "soak") as pending:
                while not stop.is_set() or pending.status()["pending_batches"]:
                    elapsed = time.monotonic() - begin
                    if a.offline_start <= elapsed < a.offline_start + a.offline_seconds:
                        time.sleep(0.1)
                        continue
                    t = time.perf_counter()
                    sent = pending.drain(Measured(), max_batches=1)
                    if sent:
                        latencies.append((time.perf_counter() - t) * 1000)
                    else:
                        stop.wait(0.01)
        except Exception as e:
            errors.append(str(e))
            stop.set()

    thread = threading.Thread(target=sender)
    thread.start()
    count = 0
    for i in range(a.seconds * 4):
        if errors:
            raise RuntimeError(errors[0])
        t = np.arange(i * 250, (i + 1) * 250) / 1000
        signal = np.sin(2 * np.pi * (np.arange(64)[:, None] + 8) * t) * 1e-5
        s.signal(
            "eeg", signal.astype("<f4"), t, sample_start=i * 250, segment_id="soak"
        )
        count += 1
        max_pending = max(max_pending, q.status()["pending_bytes"])
        if i % 240 == 0:
            Path(a.report).write_text(
                json.dumps(
                    {
                        "state": "recording",
                        "elapsed_seconds": round(time.monotonic() - begin),
                        "chunks": count,
                        "max_pending_bytes": max_pending,
                    }
                )
            )
        time.sleep(max(0, begin + (i + 1) / 4 - time.monotonic()))
    stop.set()
    thread.join(timeout=300)
    if thread.is_alive() or errors:
        raise RuntimeError(str(errors or "Sender did not drain"))
    bci = BCIClient(c)
    rows = list(bci.records(s.id, record_type="signal"))
    assert len(rows) == count
    assert (
        sum(int(r["record"]["fields"]["sample_count"]) for r in rows)
        == a.seconds * 1000
    )
    for i, r in enumerate(rows):
        assert int(r["record"]["fields"]["sample_start"]) == i * 250
    timings = []
    for _ in range(50):
        t = time.perf_counter()
        bci.window(
            s.id,
            "eeg",
            max(0, (a.seconds - 10) * 1_000_000),
            a.seconds * 1_000_000,
            channels=list(range(16)),
        )
        timings.append((time.perf_counter() - t) * 1000)
    stats = c.call("stats")
    server.stop(crash=True)
    server.start()
    assert c.call("stats")["edge_versions"] == stats["edge_versions"]

    def percentiles(v):
        return {f"p{n}_ms": float(np.percentile(v, n)) for n in (50, 95, 99)}

    result = {
        "passed": True,
        "duration_seconds": a.seconds,
        "clock": "real-time producer, synthetic samples",
        "channels": 64,
        "sample_rate_hz": 1000,
        "chunk_samples": 250,
        "chunks": count,
        "samples_per_channel": a.seconds * 1000,
        "transport_outage_seconds": a.offline_seconds,
        "max_pending_bytes": max_pending,
        "duplicate_or_missing_chunks": 0,
        "durability": "fsync + forced process kill/reopen",
        "transport": "local HTTP; native debug build; excludes WAN/TLS",
        "native_ingest": percentiles(ingest),
        "asset_upload_and_commit": percentiles(latencies),
        "window_16_channels_10_seconds": percentiles(timings),
    }
    Path(a.report).write_text(json.dumps(result, indent=2))
    print(json.dumps(result))
finally:
    stop.set()
    if q:
        q.close()
    server.close()
