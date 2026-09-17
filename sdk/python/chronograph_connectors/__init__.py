"""Explicit normalized transport: no model execution or automatic device discovery."""
import http.client
import math
import json
import os
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlsplit


class ApiError(RuntimeError):
    def __init__(self, status, message, code="HTTP_ERROR", retry_after=None):
        self.status, self.code, self.retry_after = status, code, retry_after
        super().__init__(f"HTTP {status}: {message}")


class Client:
    """Scoped bearer client. Redirects are rejected; remote endpoints require TLS."""
    def __init__(self, url, token, timeout=30, max_response_bytes=4*1024*1024):
        parsed = urlsplit(url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/")):
            raise ValueError("Use an HTTP(S) origin without credentials or a path")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("Remote endpoints require HTTPS")
        if not token or any(ord(c) <= 32 or ord(c) == 127 for c in token):
            raise ValueError("A bearer token is required")
        if not math.isfinite(timeout) or timeout <= 0 or type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 256*1024*1024:
            raise ValueError("Invalid client bounds")
        self._origin, self._token, self.timeout = parsed, token, timeout
        self.max_response_bytes = max_response_bytes

    def request(self, path, method="POST", body=None):
        """Bounded bytes for JSON, Arrow and backup endpoints; timeout is socket inactivity."""
        if not re.fullmatch(r"/v1/[a-z_]+(?:/[A-Za-z0-9_-]+)?", path) or method not in ("GET", "POST", "DELETE"):
            raise ValueError("Invalid API path/method")
        payload = None if body is None else json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
        if payload is not None and len(payload) > 4 * 1024 * 1024:
            raise ValueError("Request exceeds 4 MiB")
        cls = http.client.HTTPSConnection if self._origin.scheme == "https" else http.client.HTTPConnection
        conn = cls(self._origin.hostname, self._origin.port, timeout=self.timeout)
        try:
            conn.request(method, path, payload, {
                "Authorization": "Bearer " + self._token, "Content-Type": "application/json"
            })
            response = conn.getresponse()
            raw = response.read(self.max_response_bytes + 1)
            if len(raw) > self.max_response_bytes:
                raise ApiError(response.status, "Response exceeds configured limit", "RESPONSE_LIMIT")
            if not 200 <= response.status < 300:
                code, message = "HTTP_ERROR", "Request rejected"
                try:
                    error = json.loads(raw)["error"]
                    code, message = str(error.get("code", code)), str(error.get("message", message))
                except (ValueError, KeyError, TypeError, AttributeError):
                    pass
                raise ApiError(response.status, message[:1000], code, response.getheader("Retry-After"))
            return raw
        finally:
            conn.close()

    def call(self, operation, arguments=None):
        if not re.fullmatch(r"[a-z_]+", operation):
            raise ValueError("Invalid operation")
        raw = self.request("/v1/" + operation, body=arguments if arguments is not None else {})
        try:
            result = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeDecodeError):
            raise ApiError(200, "Expected JSON object response", "INVALID_JSON") from None

    def info(self):
        return json.loads(self.request("/v1/info", "GET"))

    def ingest(self, instance, partition, sequence, records):
        return self.call("connector_ingest", {"instance":instance,"partition":partition,"sequence":str(sequence),"records":records})

    def pages(self, operation, arguments=None, *, max_pages=1000):
        if operation not in ("as_of", "between", "history", "neighbors") or type(max_pages) is not int or max_pages < 1:
            raise ValueError("Invalid paginated operation or limit")
        args, seen = dict(arguments or {}), set()
        for _ in range(max_pages):
            result = self.call(operation, args)
            yield result
            cursor = result.get("next_cursor")
            if cursor is None:
                return
            if not isinstance(cursor, str) or cursor in seen:
                raise ValueError("Invalid pagination cursor")
            seen.add(cursor)
            args["cursor"] = cursor
        raise ValueError("Pagination limit reached")

    def asset(self, data, *, kind="tensor", encoding="raw_le", dtype="f32", shape=(), provenance=None):
        if not 0 < len(data) <= 16 * 1024 * 1024:
            raise ValueError("Assets require 1 byte to 16 MiB; split larger recordings")
        metadata = {"version":1, "kind":kind, "encoding":encoding,
                    "dtype":dtype if kind=="tensor" else None,
                    "shape":list(shape) if kind=="tensor" else [], "provenance":provenance or {}}
        if len(data)<=1024*1024:
            return self.call("asset_put", {"metadata":metadata,"data_hex":bytes(data).hex()})["asset"]
        chunks=[]
        for offset in range(0,len(data),1024*1024):
            chunks.append(self.asset(data[offset:offset+1024*1024],kind="opaque",encoding="chunk_v1"))
        return self.call("asset_compose", {"metadata":metadata,"chunks":chunks})["asset"]

    def read_asset(self, asset):
        data, expected, metadata = bytearray(), None, None
        for _ in range(16):
            result = self.call("asset_get", {"asset":asset,"content":True,"offset":len(data)})
            size, encoded = result.get("bytes"), result.get("data_hex")
            if (result.get("asset") != asset or result.get("offset") != len(data)
                    or type(size) is not int or not 1 <= size <= 16*1024*1024
                    or (expected is not None and expected != size)
                    or not isinstance(encoded, str) or len(encoded) > 2*1024*1024
                    or not re.fullmatch(r"(?:[0-9a-fA-F]{2})+", encoded)):
                raise ValueError("Invalid asset page")
            if metadata is not None and metadata != result["metadata"]:
                raise ValueError("Asset metadata changed between pages")
            expected, metadata = size, result["metadata"]
            data.extend(bytes.fromhex(encoded))
            if len(data) > size:
                raise ValueError("Invalid asset length")
            if result.get("next_offset") is None:
                if len(data) != size:
                    raise ValueError("Truncated asset")
                return metadata, bytes(data)
            if result["next_offset"] != len(data) or len(data) >= size:
                raise ValueError("Non-progressing asset cursor")
        raise ValueError("Asset page limit exceeded")

    def tensor(self, array, *, provenance=None):
        """Upload a NumPy-compatible array without requiring NumPy at installation time."""
        dtype = array.dtype
        names = {"uint8":"u8", "int8":"i8", "uint16":"u16", "uint32":"u32", "uint64":"u64", "int16":"i16", "int32":"i32", "int64":"i64", "float16":"f16", "float32":"f32", "float64":"f64", "bool":"bool"}
        if dtype.name not in names or dtype.hasobject:
            raise ValueError("Unsupported tensor dtype; object arrays are never serialized")
        # astype performs numerical endian conversion, not merely relabeling bytes.
        little = array.astype(dtype.newbyteorder("<"), copy=False)
        return self.asset(little.tobytes(order="C"), dtype=names[dtype.name], shape=array.shape, provenance=provenance)

    def checkpoint(self, instance, partition):
        return self.call("connector_checkpoint", {"instance":instance, "partition":partition})["checkpoint"]


def _private_file(path):
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    os.close(fd)
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError("Spool files must be private regular files (mode 0600)")


class Spool:
    """A bounded, durable queue for one instance/partition. Stores no credentials.

    A failed or uncertain request leaves the exact batch queued. Pause/cancel stop
    subsequent sends; already acknowledged records remain committed. Pending rows
    are retained for inspection and explicit resume, including uncertain requests.
    """
    def __init__(self, directory, instance, partition="main", *, start_sequence=0, max_bytes=64*1024*1024):
        if any(not re.fullmatch(r"[A-Za-z0-9_.-]{1,96}", x) for x in (instance, partition)):
            raise ValueError("Invalid instance/partition")
        if not 0 <= start_sequence <= 2**63-1:
            raise ValueError("Invalid spool starting sequence")
        self.root = Path(directory)
        if self.root.is_symlink():
            raise ValueError("Spool directory cannot be a symlink")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.stat().st_mode & 0o077:
            raise ValueError("Spool directory must be private (mode 0700)")
        self.instance, self.partition, self.max_bytes = instance, partition, max_bytes
        path = self.root / "spool.sqlite3"
        _private_file(path)
        self.db = sqlite3.connect(path, timeout=5)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1), instance TEXT, partition TEXT, next INTEGER, state TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS queue(sequence INTEGER PRIMARY KEY, body BLOB NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS receipts(sequence INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO config VALUES (1,?,?,?,'running')", (instance,partition,start_sequence))
        row = self.db.execute("SELECT instance,partition FROM config WHERE id=1").fetchone()
        if row != (instance, partition):
            self.close()
            raise ValueError("Spool belongs to another instance/partition")

    def enqueue(self, records):
        if not 1 <= len(records) <= 500:
            raise ValueError("Batch requires 1–500 records")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            seq = self.db.execute("SELECT next FROM config WHERE id=1").fetchone()[0]
            if seq >= 2**63-1:
                raise ValueError("Spool sequence limit reached; use a new partition")
            body = json.dumps({"instance":self.instance,"partition":self.partition,"sequence":str(seq),"records":records}, separators=(",", ":"), allow_nan=False).encode()
            size = self.db.execute("SELECT COALESCE(SUM(length(body)),0) FROM queue").fetchone()[0]
            if len(body)>2*1024*1024 or size+len(body)>self.max_bytes:
                raise ValueError("Spool capacity exceeded; apply producer backpressure")
            self.db.execute("INSERT INTO queue VALUES (?,?)", (seq,body))
            self.db.execute("UPDATE config SET next=? WHERE id=1", (seq+1,))
        return seq

    def status(self):
        state = self.db.execute("SELECT state FROM config WHERE id=1").fetchone()[0]
        count, size = self.db.execute("SELECT count(*),COALESCE(SUM(length(body)),0) FROM queue").fetchone()
        return {"instance":self.instance,"partition":self.partition,"state":state,"pending_batches":count,"pending_bytes":size}

    def control(self, state):
        if state not in ("running", "paused", "cancelled"):
            raise ValueError("Invalid state")
        with self.db:
            self.db.execute("UPDATE config SET state=? WHERE id=1", (state,))

    def drain(self, client, *, max_batches=100):
        import fcntl  # Local agent is supported on Linux/macOS.
        lockpath=self.root / "producer.lock"
        _private_file(lockpath)
        sent=0
        with lockpath.open("r+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            while sent < max_batches and self.status()["state"]=="running":
                row=self.db.execute("SELECT sequence,body FROM queue ORDER BY sequence LIMIT 1").fetchone()
                if row is None:
                    break
                seq,body=row
                result=client.call("connector_ingest",json.loads(body))
                receipt=result["receipt"]
                if (receipt.get("instance"),receipt.get("partition"),receipt.get("sequence"),receipt.get("durability")) != (self.instance,self.partition,str(seq),"fsync"):
                    raise ValueError("Server returned an inconsistent receipt; batch retained")
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO receipts VALUES (?,?)", (seq,json.dumps(receipt)))
                    self.db.execute("DELETE FROM queue WHERE sequence=?", (seq,))
                    self.db.execute("DELETE FROM receipts WHERE sequence < ?", (seq-999,))
                sent+=1
        return sent

    def close(self):
        self.db.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
