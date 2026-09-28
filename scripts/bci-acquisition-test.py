"""Real BrainFlow synthetic driver + LSL loopback; no physical-board claim."""

from pathlib import Path
import threading, time, uuid
import numpy as np
from bci_support import Service
from chronograph_connectors.bci import Session, BCIClient, initialize
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import brainflow_capture, lsl_capture
from pylsl import StreamInfo, StreamOutlet, local_clock

s = Service(18094)
try:
    initialize(s.client, "board_test", 431, "unix_us")
    with BCISpool(s.root / "board", "board_test", "synthetic_driver") as q:
        v = Session(q, source="brainflow", clock_domain="unix_us")
        brainflow_capture(v, board_id=-1, params={}, seconds=2, units="uV")
        q.drain(s.client, max_batches=1000)
        records = list(
            BCIClient(s.client, "board_test").records(v.id, record_type="signal")
        )
        assert records and all(
            "package_counters" in r["record"]["assets"] for r in records
        )
        samples = sum(int(r["record"]["fields"]["sample_count"]) for r in records)
        assert samples > 100
    initialize(s.client, "lsl_test", 432, "lsl_local_us")
    # Different machine boot epochs can legitimately differ by more than a day.
    with BCISpool(s.root / "offset", "lsl_test", "offset") as q:
        shifted = Session(q, source="lsl", clock_domain="lsl_local_us")
        shifted.stream("eeg", channels=["C3"], units=["uV"], sample_rate_hz=250)
        shifted.signal(
            "eeg",
            np.array([[1.0, 2.0]], dtype="<f4"),
            [172800.0, 172800.004],
            sample_start=0,
            segment_id="offset",
            correction_seconds=-172800.0,
        )
        q.drain(s.client)
        assert BCIClient(s.client, "lsl_test").window(shifted.id, "eeg", 0, 8000)[
            "channels"
        ]
    source = "chronodb-loopback-" + uuid.uuid4().hex
    outlet = StreamOutlet(
        StreamInfo("ChronoDB synthetic QA", "EEG", 2, 250, "float32", source)
    )
    stop = threading.Event()
    sent = {}

    def producer():
        count = 0
        start = local_clock()
        while not stop.is_set():
            timestamp = start + count / 250
            sample = [float(count), float(-count)]
            sent[count] = timestamp
            outlet.push_sample(sample, timestamp)
            count += 1
            stop.wait(max(0, start + count / 250 - local_clock()))

    thread = threading.Thread(target=producer)
    thread.start()
    try:
        with BCISpool(s.root / "lsl", "lsl_test", "loopback") as q:
            v = Session(q, source="lsl", clock_domain="lsl_local_us")
            lsl_capture(
                v,
                source_id=source,
                channels=["C3", "C4"],
                units=["uV", "uV"],
                seconds=6,
                expected_rate=250,
            )
            q.drain(s.client, max_batches=1000)
            chunks = list(BCIClient(s.client, "lsl_test").chunks(v.id, "eeg"))
            assert chunks
            data = np.concatenate([c[1] for c in chunks], axis=1)
            ts = np.concatenate([c[2] for c in chunks])
            assert data.shape[1] > 250
            np.testing.assert_array_equal(data[0], -data[1])
            np.testing.assert_array_equal(
                ts, np.asarray([sent[int(i)] for i in data[0]])
            )
            assert list(
                BCIClient(s.client, "lsl_test").records(v.id, record_type="clock")
            )
    finally:
        stop.set()
        thread.join()
    print(
        "PASS actual BrainFlow synthetic driver, preserved counters, LSL loopback values and original timestamps, clock measurements. No physical device tested."
    )
finally:
    s.close()
