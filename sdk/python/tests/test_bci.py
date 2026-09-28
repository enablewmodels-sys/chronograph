import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci import Session


class Transport:
    def __init__(self):
        self.assets = {}
        self.batches = {}
        self.lose = False

    def asset(self, data, **metadata):
        key = hashlib.sha256(
            json.dumps(metadata, sort_keys=True).encode() + data
        ).hexdigest()[:32]
        self.assets[key] = (metadata, bytes(data))
        return key

    def call(self, op, body):
        old = self.batches.setdefault(body["sequence"], body)
        assert old == body
        if self.lose:
            self.lose = False
            raise OSError("lost acknowledgement")
        return {
            "receipt": {
                "instance": body["instance"],
                "partition": body["partition"],
                "sequence": body["sequence"],
                "durability": "fsync",
            }
        }


class Tests(unittest.TestCase):
    def test_offline_asset_lost_ack_and_restart(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "queue"
            net = Transport()
            with BCISpool(path, "eeg") as q:
                s = Session(q, session_id="15")
                s.stream(
                    "eeg", channels=["C3", "C4"], units=["uV", "uV"], sample_rate_hz=250
                )
                raw = np.array(
                    [[1, float("nan"), float("inf")], [2, 3, 4]], dtype="<f4"
                )
                ts = np.array([1, 1.004, 1.008])
                s.signal("eeg", raw, ts, sample_start=0, segment_id="a")
                self.assertGreater(q.status()["pending_bytes"], raw.nbytes)
                net.lose = True
                with self.assertRaises(OSError):
                    q.drain(net)
                self.assertEqual(q.status()["pending_batches"], 3)
                q.control("paused")
                self.assertEqual(q.drain(net), 0)
            with BCISpool(path, "eeg") as q:
                self.assertEqual(Session(q).id, "15")
                q.control("running")
                self.assertEqual(q.drain(net), 3)
                self.assertEqual(q.status()["pending_bytes"], 0)
                record = net.batches["2"]["records"][0]
                self.assertEqual(
                    net.assets[record["assets"]["signal"]][1], raw.tobytes()
                )
                self.assertEqual(
                    net.assets[record["assets"]["timestamps"]][1],
                    ts.astype("<f8").tobytes(),
                )

    def test_capacity_rolls_back_entire_chunk(self):
        with tempfile.TemporaryDirectory() as root:
            with BCISpool(Path(root) / "queue", "eeg", max_bytes=1024 * 1024) as q:
                s = Session(q)
                s.stream(
                    "eeg", channels=["C3", "C4"], units=["V", "V"], sample_rate_hz=10000
                )
                before = q.status()
                with self.assertRaises(BufferError):
                    s.signal(
                        "eeg",
                        np.zeros((2, 60000)),
                        np.arange(60000) / 10000,
                        sample_start=0,
                        segment_id="a",
                    )
                self.assertEqual(q.status(), before)

    def test_bad_shape_clock_and_immutable_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            with BCISpool(Path(root) / "queue", "eeg") as q:
                s = Session(q)
                s.stream("eeg", channels=["C3"], units=["V"], sample_rate_hz=250)
                with self.assertRaises(ValueError):
                    s.stream("eeg", channels=["C4"], units=["V"], sample_rate_hz=250)
                with self.assertRaises(ValueError):
                    s.signal(
                        "eeg", np.zeros((1, 2)), [2, 1], sample_start=0, segment_id="a"
                    )
                with self.assertRaises(ValueError):
                    Session(q, clock_domain="device_us")

    def test_corruption_preserves_pending_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            with BCISpool(Path(root) / "queue", "eeg") as q:
                s = Session(q)
                s.stream("eeg", channels=["C3"], units=["V"], sample_rate_hz=250)
                s.signal(
                    "eeg", np.zeros((1, 2)), [0, 0.004], sample_start=0, segment_id="a"
                )
                with q.db:
                    q.db.execute(
                        "UPDATE asset SET data=? WHERE id=(SELECT id FROM asset LIMIT 1)",
                        (b"corrupt",),
                    )
                with self.assertRaises(ValueError):
                    q.drain(Transport())
                self.assertEqual(q.status()["pending_batches"], 1)


if __name__ == "__main__":
    unittest.main()
