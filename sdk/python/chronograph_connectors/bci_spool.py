"""Private, durable offline asset + record spool. No credentials are persisted."""

from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
from . import Client, _private_file


def encode(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


class BCISpool:
    def __init__(
        self,
        directory,
        instance,
        partition="bci",
        *,
        max_bytes=1024**3,
        start_sequence=0,
    ):
        if any(
            not re.fullmatch(r"[A-Za-z0-9_.-]{1,48}", v) for v in (instance, partition)
        ):
            raise ValueError("Invalid instance/partition")
        if (
            type(max_bytes) is not int
            or max_bytes < 1024 * 1024
            or not 0 <= start_sequence < 2**63
        ):
            raise ValueError("Invalid spool capacity/sequence")
        self.root = Path(directory)
        if self.root.is_symlink():
            raise ValueError("Spool cannot be a symlink")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.stat().st_mode & 0o077:
            raise ValueError("Spool directory requires mode 0700")
        self.instance, self.partition, self.max_bytes = instance, partition, max_bytes
        path = self.root / "bci.sqlite3"
        _private_file(path)
        self.db = sqlite3.connect(path, timeout=10)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT, partition TEXT, next INTEGER, state TEXT, session TEXT);
          CREATE TABLE IF NOT EXISTS asset(id TEXT PRIMARY KEY, metadata BLOB, data BLOB, remote TEXT, refs INTEGER DEFAULT 0);
          CREATE TABLE IF NOT EXISTS queue(sequence INTEGER PRIMARY KEY, body BLOB, frozen BLOB);
          CREATE TABLE IF NOT EXISTS receipt(sequence INTEGER PRIMARY KEY, body BLOB);
        """)
        with self.db:
            self.db.execute(
                "INSERT OR IGNORE INTO config VALUES(1,?,?,?,'running','{}')",
                (instance, partition, start_sequence),
            )
        if self.db.execute("SELECT instance,partition FROM config").fetchone() != (
            instance,
            partition,
        ):
            self.db.close()
            raise ValueError("Spool belongs to another source")

    @contextmanager
    def transaction(self):
        if self.db.in_transaction:
            yield
        else:
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                yield

    def state(self):
        return json.loads(self.db.execute("SELECT session FROM config").fetchone()[0])

    def _used(self):
        return self.db.execute(
            "SELECT COALESCE((SELECT SUM(length(data)+length(metadata)) FROM asset),0)+COALESCE((SELECT SUM(2*length(body)) FROM queue),0)"
        ).fetchone()[0]

    def _capacity(self, size):
        if self._used() + size > self.max_bytes:
            raise BufferError(
                "BCI spool is full; acquisition stopped, pending data retained"
            )
        free = os.statvfs(self.root)
        if free.f_bavail * free.f_frsize < size + 64 * 1024 * 1024:
            raise BufferError("BCI spool disk reserve reached; acquisition stopped")

    def asset(
        self,
        data,
        *,
        kind="tensor",
        encoding="raw_le",
        dtype="f32",
        shape=(),
        provenance=None,
    ):
        if not 0 < len(data) <= 16 * 1024 * 1024:
            raise ValueError("Asset exceeds 16 MiB; use smaller chunks")
        meta = encode(
            {
                "kind": kind,
                "encoding": encoding,
                "dtype": dtype,
                "shape": list(shape),
                "provenance": provenance or {},
            }
        )
        data = bytes(data)
        key = "local:" + hashlib.sha256(meta + b"\0" + data).hexdigest()
        with self.transaction():
            if not self.db.execute("SELECT 1 FROM asset WHERE id=?", (key,)).fetchone():
                self._capacity(len(data) + len(meta))
                self.db.execute(
                    "INSERT INTO asset(id,metadata,data) VALUES(?,?,?)",
                    (key, meta, data),
                )
        return key

    tensor = Client.tensor

    def enqueue(self, records, *, state=None):
        if not 1 <= len(records) <= 500:
            raise ValueError("Batch requires 1–500 records")
        with self.transaction():
            seq = self.db.execute("SELECT next FROM config").fetchone()[0]
            if seq >= 2**63 - 1:
                raise ValueError("Sequence exhausted; use a new partition")
            body = encode(
                {
                    "instance": self.instance,
                    "partition": self.partition,
                    "sequence": str(seq),
                    "records": records,
                }
            )
            if len(body) > 2 * 1024 * 1024:
                raise ValueError("Batch exceeds 2 MiB")
            self._capacity(2 * len(body))
            for key in {a for r in records for a in r.get("assets", {}).values()}:
                if (
                    not key.startswith("local:")
                    or not self.db.execute(
                        "UPDATE asset SET refs=refs+1 WHERE id=?", (key,)
                    ).rowcount
                ):
                    raise ValueError(
                        "BCI offline records require assets from this spool"
                    )
            self.db.execute("INSERT INTO queue(sequence,body) VALUES(?,?)", (seq, body))
            self.db.execute("UPDATE config SET next=? WHERE id=1", (seq + 1,))
            if state is not None:
                self.db.execute(
                    "UPDATE config SET session=? WHERE id=1", (encode(state).decode(),)
                )
        return seq

    def status(self):
        count = self.db.execute("SELECT COUNT(*) FROM queue").fetchone()[0]
        return {
            "instance": self.instance,
            "partition": self.partition,
            "pending_batches": count,
            "pending_bytes": self._used(),
            "max_bytes": self.max_bytes,
            "state": self.db.execute("SELECT state FROM config").fetchone()[0],
        }

    def control(self, state):
        if state not in ("running", "paused", "cancelled"):
            raise ValueError("Unknown state")
        with self.transaction():
            self.db.execute("UPDATE config SET state=?", (state,))

    def drain(self, client, *, max_batches=100):
        import fcntl

        path = self.root / "sender.lock"
        _private_file(path)
        sent = 0
        with path.open("r+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            while sent < max_batches and self.status()["state"] == "running":
                row = self.db.execute(
                    "SELECT sequence,body,frozen FROM queue ORDER BY sequence LIMIT 1"
                ).fetchone()
                if row is None:
                    break
                seq, body, frozen = row
                original = json.loads(body)
                keys = {
                    a for r in original["records"] for a in r.get("assets", {}).values()
                }
                if frozen is None:
                    outgoing = json.loads(body)
                    mapping = {}
                    for key in sorted(keys):
                        meta, data, remote = self.db.execute(
                            "SELECT metadata,data,remote FROM asset WHERE id=?", (key,)
                        ).fetchone()
                        if (
                            "local:" + hashlib.sha256(meta + b"\0" + data).hexdigest()
                            != key
                        ):
                            raise ValueError(
                                "Local signal checksum failed; spool retained"
                            )
                        if not remote:
                            remote = client.asset(data, **json.loads(meta))
                            if not re.fullmatch("[0-9a-f]{32}", remote):
                                raise ValueError("Invalid remote asset ID")
                            with self.transaction():
                                self.db.execute(
                                    "UPDATE asset SET remote=? WHERE id=?",
                                    (remote, key),
                                )
                        mapping[key] = remote
                    for r in outgoing["records"]:
                        r["assets"] = {
                            name: mapping[key]
                            for name, key in r.get("assets", {}).items()
                        }
                    frozen = encode(outgoing)
                    with self.transaction():
                        self.db.execute(
                            "UPDATE queue SET frozen=? WHERE sequence=?", (frozen, seq)
                        )
                result = client.call("connector_ingest", json.loads(frozen))["receipt"]
                if (
                    result.get("instance"),
                    result.get("partition"),
                    result.get("sequence"),
                    result.get("durability"),
                ) != (self.instance, self.partition, str(seq), "fsync"):
                    raise ValueError("Inconsistent durable receipt; batch retained")
                # Native digest binds its normalized struct serialization; sequence,
                # source and partition are verified here, byte identity is frozen.
                with self.transaction():
                    self.db.execute(
                        "INSERT OR REPLACE INTO receipt VALUES(?,?)",
                        (seq, encode(result)),
                    )
                    self.db.execute("DELETE FROM queue WHERE sequence=?", (seq,))
                    for key in keys:
                        self.db.execute(
                            "UPDATE asset SET refs=refs-1 WHERE id=?", (key,)
                        )
                        self.db.execute(
                            "DELETE FROM asset WHERE id=? AND refs=0", (key,)
                        )
                    self.db.execute(
                        "DELETE FROM receipt WHERE sequence<?", (seq - 999,)
                    )
                sent += 1
        return sent

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
