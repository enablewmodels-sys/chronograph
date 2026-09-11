import json
from pathlib import Path
import tempfile
import unittest
from chronograph_connectors import Spool, Client

class Fake:
    def __init__(self): self.seen={}; self.lose=True
    def call(self, op, batch):
        key=batch["sequence"]
        if key in self.seen: assert self.seen[key]==batch
        self.seen[key]=batch
        if self.lose:
            self.lose=False
            raise OSError("lost acknowledgment")
        return {"receipt":{"instance":batch["instance"],"partition":batch["partition"],"sequence":key,"durability":"fsync"}}

class Tests(unittest.TestCase):
    def test_lost_ack_pause_restart_and_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/"spool"
            transport=Fake()
            with Spool(root,"sensor") as queue:
                self.assertEqual(queue.enqueue([{"src":"1"}]),0)
                with self.assertRaises(OSError): queue.drain(transport)
                self.assertEqual(queue.status()["pending_batches"],1)
                queue.control("paused")
                self.assertEqual(queue.drain(transport),0)
            with Spool(root,"sensor") as queue:
                self.assertEqual(queue.status()["state"],"paused")
                queue.control("running")
                self.assertEqual(queue.drain(transport),1)
                self.assertEqual(queue.enqueue([{"src":"2"}]),1)
                queue.control("cancelled")
                self.assertEqual(queue.drain(transport),0)
                self.assertEqual(queue.status()["pending_batches"],1)
                queue.control("running");queue.drain(transport)
                self.assertEqual(len(transport.seen),2)
            with self.assertRaises(ValueError): Spool(root,"other")
            with Spool(Path(directory)/"tiny","sensor",max_bytes=1) as queue:
                with self.assertRaises(ValueError): queue.enqueue([{}])
                self.assertEqual(queue.status()["pending_batches"],0)
    def test_remote_tls_and_no_credentials_in_urls(self):
        for url in ["http://example.com","https://secret@example.com","https://example.com/path","https://example.com/?token=secret"]:
            with self.assertRaises(ValueError): Client(url,"token")
        Client("https://example.com","token")

if __name__=="__main__": unittest.main()
