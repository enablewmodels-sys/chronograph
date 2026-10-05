"""BCI research sessions. Raw data is immutable; derived results retain lineage."""

import hashlib
import json
import math
import secrets
import time
from . import Client, ApiError
from .bci_spool import BCISpool, encode


class BCITransport(Client):
    """Bounded retry for project admission limits; exact request bytes are reused."""

    def call(self, *args, **kwargs):
        for attempt in range(5):
            try:
                return super().call(*args, **kwargs)
            except ApiError as error:
                if error.status != 429 or attempt == 4:
                    raise
                try:
                    delay = float(error.retry_after or 60)
                except (TypeError, ValueError):
                    delay = 60
                time.sleep(min(60, max(1, delay)))


def _us(seconds):
    """Microsecond timestamp with the same rounding the server validates with.

    The service checks coverage with Rust's float round, which is half-away-from-zero,
    while Python round() is half-to-even. A time that lands exactly on a half
    microsecond would otherwise be accepted here and rejected on ingest with
    "Signal timestamps must be finite, nondecreasing and within declared coverage".
    """
    value = float(seconds) * 1e6
    if not math.isfinite(value):
        raise ValueError("Timestamp must be finite")
    return int(math.floor(value + 0.5)) if value >= 0 else int(math.ceil(value - 0.5))


def uid():
    return str(secrets.randbits(63) or 1)


def binding(instance="bci_research", kind=430, clock_domain="unix_us"):
    return {
        "id": instance,
        "connector": "bci",
        "preset": "research-v1",
        "contract_version": 1,
        "kind": kind,
        "clock_domain": clock_domain,
    }


def initialize(client, instance="bci_research", kind=430, clock_domain="unix_us"):
    config = binding(instance, kind, clock_domain)
    schema = client.call("schema")
    existing = next(
        (b for b in schema.get("connectors", []) if b["id"] == instance), None
    )
    if existing:
        if any(existing.get(k) != v for k, v in config.items()):
            raise ValueError(
                "Existing BCI binding differs; choose a new instance and relation kind"
            )
        return existing
    source = client.call("connector_template", config)["source"]
    preview = client.call("schema_preview", {"source": source})
    return client.call(
        "schema_apply",
        {
            "source": source,
            "checksum": preview["checksum"],
            "expected_revision": preview["expected_revision"],
        },
    )


class Session:
    def __init__(
        self,
        spool: BCISpool,
        *,
        name="EEG recording",
        study="research",
        participant="synthetic",
        source="synthetic",
        device="synthetic",
        driver="chronograph-bci-v1",
        clock_domain="unix_us",
        session_id=None,
        start_us=0,
    ):
        self.spool = spool
        self.on_signal = None
        self.state = spool.state()
        if self.state:
            if session_id is not None and self.state["id"] != str(session_id):
                raise ValueError("Spool already belongs to another session")
            if self.state["clock_domain"] != clock_domain:
                raise ValueError("Session clock cannot change")
            self.id = self.state["id"]
            self.clock = clock_domain
            return
        self.id = str(session_id or uid())
        self.clock = clock_domain
        if not self.id.isdecimal() or not 0 < int(self.id) < 2**64:
            raise ValueError("Session ID must be a nonzero u64 decimal")
        self.state = {"id": self.id, "clock_domain": clock_domain, "streams": {}}
        record = self.record(
            "session",
            start_us,
            name=name,
            study=study,
            participant=participant,
            source=source,
            device=device,
            driver=driver,
        )
        record["dst"] = self.id
        spool.enqueue([record], state=self.state)

    def record(self, typ, timestamp_us, **fields):
        return {
            "src": self.id,
            "dst": uid(),
            "timestamp_us": str(timestamp_us),
            "assets": {},
            "fields": {
                "type": typ,
                "session_id": self.id,
                "clock_domain": self.clock,
                **fields,
            },
        }

    def stream(
        self,
        stream_id,
        *,
        channels,
        units,
        sample_rate_hz,
        channel_types=None,
        reference="unspecified",
        source_clock=None,
        electrodes=None,
    ):
        types = channel_types or ["EEG"] * len(channels)
        if (
            not 1 <= len(channels) <= 512
            or len(set(channels)) != len(channels)
            or len(units) != len(channels)
            or len(types) != len(channels)
        ):
            raise ValueError("Unique channel names, types and units are required")
        if not math.isfinite(sample_rate_hz) or not 0 < sample_rate_hz <= 100_000:
            raise ValueError("Invalid sample rate")
        fields = {
            "stream_id": stream_id,
            "channels": list(channels),
            "units": list(units),
            "channel_types": list(types),
            "sample_rate_hz": sample_rate_hz,
            "reference": reference,
            "source_clock": source_clock or self.clock,
            "electrodes": electrodes or {},
        }
        old = self.state["streams"].get(stream_id)
        if old is not None:
            if old != fields:
                raise ValueError("Stream metadata changed; use a new stream ID")
            return
        state = json.loads(encode(self.state))
        state["streams"][stream_id] = fields
        self.spool.enqueue([self.record("stream", 0, **fields)], state=state)
        self.state = state

    def signal(
        self,
        stream_id,
        samples,
        timestamps,
        *,
        sample_start,
        segment_id,
        correction_seconds=0.0,
        auxiliary=None,
    ):
        import numpy as np

        meta = self.state["streams"][stream_id]
        data = np.asarray(samples)
        times = np.asarray(timestamps, dtype="<f8")
        if (
            data.dtype.name not in ("float32", "float64")
            or data.ndim != 2
            or data.shape != (len(meta["channels"]), len(times))
            or not len(times)
            or not np.isfinite(times).all()
            or np.any(np.diff(times) < 0)
        ):
            raise ValueError(
                "Expected f32/f64 [channels,samples] and finite nondecreasing timestamps"
            )
        if (
            type(sample_start) is not int
            or sample_start < 0
            or sample_start + len(times) >= 2**64
        ):
            raise ValueError("Invalid sample indices")
        if not math.isfinite(correction_seconds):
            raise ValueError("Invalid clock correction")
        start = _us(float(times[0]) + correction_seconds)
        end = _us(float(times[-1]) + correction_seconds) + max(
            1, round(1e6 / meta["sample_rate_hz"])
        )
        if end - start > 60_000_000 or not -(2**63) <= start < end < 2**63 - 1:
            raise ValueError("Chunk exceeds clock or 60-second bounds")
        r = self.record(
            "signal",
            start,
            stream_id=stream_id,
            segment_id=segment_id,
            sample_start=str(sample_start),
            sample_count=str(len(times)),
            end_us=str(end),
            correction_seconds=correction_seconds,
        )
        # One durable transaction: another sender cannot collect assets between
        # tensor publication and reference publication.
        with self.spool.transaction():
            r["assets"] = {
                "signal": self.spool.tensor(data),
                "timestamps": self.spool.tensor(times),
            }
            for name, array in (auxiliary or {}).items():
                if name in r["assets"]:
                    raise ValueError(
                        "Auxiliary tensor cannot replace a signal or timestamp"
                    )
                r["assets"][name] = self.spool.tensor(np.asarray(array, dtype="<f8"))
            self.spool.enqueue([r])
        if self.on_signal:
            self.on_signal(stream_id, data, times + correction_seconds)
        return r["dst"]

    def event(
        self,
        stream_id,
        timestamp_us,
        label,
        *,
        category="marker",
        end_us=None,
        **metadata,
    ):
        r = self.record(
            "event",
            timestamp_us,
            stream_id=stream_id,
            label=label,
            category=category,
            end_us=str(timestamp_us if end_us is None else end_us),
            metadata=metadata,
        )
        self.spool.enqueue([r])
        return r["dst"]

    def gap(self, stream_id, start_us, end_us, *, reason, lost_samples=None):
        self.spool.enqueue(
            [
                self.record(
                    "gap",
                    start_us,
                    stream_id=stream_id,
                    end_us=str(end_us),
                    reason=reason,
                    lost_samples=None if lost_samples is None else str(lost_samples),
                )
            ]
        )

    def clock_measurement(
        self,
        stream_id,
        timestamp_us,
        offset_seconds,
        *,
        source_clock,
        uncertainty_seconds=None,
    ):
        self.spool.enqueue(
            [
                self.record(
                    "clock",
                    timestamp_us,
                    stream_id=stream_id,
                    end_us=str(timestamp_us),
                    offset_seconds=offset_seconds,
                    source_clock=source_clock,
                    uncertainty_seconds=uncertainty_seconds,
                )
            ]
        )

    def prediction(
        self,
        stream_id,
        start_us,
        end_us,
        *,
        run_id,
        label,
        probability,
        latency_ms=None,
        feedback=None,
    ):
        self.spool.enqueue(
            [
                self.record(
                    "prediction",
                    start_us,
                    stream_id=stream_id,
                    end_us=str(end_us),
                    run_id=str(run_id),
                    label=str(label),
                    probability=float(probability),
                    latency_ms=latency_ms,
                    feedback=feedback,
                )
            ]
        )


class BCIClient:
    def __init__(self, client, instance="bci_research"):
        self.client, self.instance = client, instance

    def sessions(self, *, max_pages=1000):
        for page in Client.pages(
            self.client,
            "bci_sessions",
            {"instance": self.instance},
            max_pages=max_pages,
        ):
            yield from page["sessions"]

    def session(self, session):
        return self.client.call(
            "bci_session", {"instance": self.instance, "session": str(session)}
        )

    def records(
        self, session, *, record_type="", stream="", after=None, max_records=100_000
    ):
        args = {
            "instance": self.instance,
            "session": str(session),
            "record_type": record_type,
            "stream": stream,
            "limit": 500,
        }
        if after is not None:
            args["after"] = str(after)
        if type(max_records) is not int or not 1 <= max_records <= 5_000_000:
            raise ValueError("Invalid record budget")
        count = 0
        for result in Client.pages(
            self.client, "bci_records", args, max_pages=min(max_records + 1, 10000)
        ):
            for row in result["records"]:
                count += 1
                if count > max_records:
                    raise ValueError("Recording exceeds local record limit")
                yield row

    def window(self, session, stream, start_us, end_us, **options):
        return self.client.call(
            "bci_window",
            {
                "instance": self.instance,
                "session": str(session),
                "stream": stream,
                "start": str(start_us),
                "end": str(end_us),
                **options,
            },
        )

    def tensor(self, asset):
        import numpy as np

        meta, raw = self.client.read_asset(asset)
        dtypes = {"f32": "<f4", "f64": "<f8"}
        if (
            meta["kind"] != "tensor"
            or meta["dtype"] not in dtypes
            or math.prod(meta["shape"]) * np.dtype(dtypes[meta["dtype"]]).itemsize
            != len(raw)
        ):
            raise ValueError("Unexpected BCI tensor")
        return (
            np.frombuffer(raw, dtype=dtypes[meta["dtype"]])
            .reshape(meta["shape"])
            .copy()
        )

    def chunks(self, session, stream):
        for row in self.records(session, record_type="signal", stream=stream):
            r = row["record"]
            yield (
                r,
                self.tensor(r["assets"]["signal"]),
                self.tensor(r["assets"]["timestamps"]),
            )

    def to_mne(self, session, stream="eeg"):
        """Return this recording as an mne.io.RawArray, without writing a file.

        This is the bridge into an existing MNE and scikit-learn pipeline: the
        channel names, types, sample rate, annotations and bad channels the
        recording stored, in an object that tooling already understands. Nothing
        is resampled, filtered or re-referenced, and a recording with explicit
        gaps is refused instead of joined, because a joined gap is a fabricated
        signal.
        """
        import numpy as np

        try:
            import mne
        except ImportError as error:
            raise RuntimeError(
                "Install the BCI extra first: pip install './sdk/python[bci]'"
            ) from error

        declarations = [
            row["record"]
            for row in self.records(session, stream=stream, record_type="stream")
        ]
        if len(declarations) != 1:
            raise ValueError(
                f"A Raw conversion needs exactly one stream declaration for {stream!r}; "
                f"found {len(declarations)}"
            )
        fields = declarations[0]["fields"]
        channels = [str(name) for name in fields["channels"]]
        units = [str(unit) for unit in fields["units"]]
        if any(unit != "V" for unit in units):
            raise ValueError(
                "Only volt-scaled channels convert to MNE; rescale the source "
                "explicitly and record the factor you applied"
            )
        rate = float(fields["sample_rate_hz"])
        if not math.isfinite(rate) or rate <= 0:
            raise ValueError("Invalid sample rate in stream metadata")
        if list(self.records(session, stream=stream, record_type="gap")):
            raise ValueError(
                "Recording contains explicit gaps; convert each continuous segment "
                "separately instead of joining them"
            )

        chunks = list(self.chunks(session, stream))
        if not chunks:
            raise ValueError("Recording has no signal chunks")
        data = np.concatenate([chunk[1] for chunk in chunks], axis=1)
        times = np.concatenate([chunk[2] for chunk in chunks])
        if data.shape[0] != len(channels) or data.shape[1] != len(times):
            raise ValueError("Signal chunks disagree with the stream declaration")
        if np.any(np.diff(times) <= 0):
            raise ValueError(
                "Timestamps must strictly increase for a Raw conversion; irregular "
                "timing needs the exact chunked export"
            )

        types = [str(kind).lower() for kind in fields["channel_types"]]
        raw = mne.io.RawArray(
            np.ascontiguousarray(data, dtype=np.float64),
            mne.create_info(channels, rate, types),
            verbose="ERROR",
        )
        origin_us = int(chunks[0][0]["timestamp_us"])
        events = [
            row["record"]
            for row in self.records(session, stream=stream, record_type="event")
        ]
        marks = []
        for record in events:
            event = record["fields"]
            start_us = int(record["timestamp_us"])
            end_us = int(event.get("end_us") or start_us)
            marks.append(
                (
                    (start_us - origin_us) / 1e6,
                    max(0.0, (end_us - start_us) / 1e6),
                    str(event["label"]),
                )
            )
        marks.sort(key=lambda mark: (mark[0], mark[2]))
        if marks:
            raw.set_annotations(
                mne.Annotations(
                    [mark[0] for mark in marks],
                    [mark[1] for mark in marks],
                    [mark[2] for mark in marks],
                )
            )
        # The writer nests extra metadata, so the channel arrives under fields.metadata
        # and the record label carries the same name. Read all three shapes rather than
        # silently returning an empty bad-channel list.
        bad = set()
        for record in events:
            fields = record["fields"]
            if fields.get("category") != "bad_channel":
                continue
            metadata = fields.get("metadata")
            name = fields.get("channel")
            if name is None and isinstance(metadata, dict):
                name = metadata.get("channel")
            bad.add(str(name if name is not None else fields.get("label")))
        raw.info["bads"] = [name for name in channels if name in bad]
        described = [
            row["record"]["fields"]
            for row in self.records(session, record_type="session")
        ]
        if described:
            raw.info["description"] = str(described[0].get("name") or "")
        return raw

    def export(self, session, stream, directory, *, max_bytes=512 * 1024 * 1024):
        """Exact chunked NumPy export; never joins gaps or silently scales units."""
        import numpy as np
        from pathlib import Path

        dest = Path(directory)
        dest.mkdir(mode=0o700, parents=True, exist_ok=False)
        manifest = {
            "version": 1,
            "session": self.session(session),
            "stream": stream,
            "chunks": [],
            "events": list(self.records(session, stream=stream, record_type="event")),
            "gaps": list(self.records(session, stream=stream, record_type="gap")),
            "clocks": list(self.records(session, stream=stream, record_type="clock")),
        }
        total = 0
        for i, (record, data, times) in enumerate(self.chunks(session, stream)):
            total += data.nbytes + times.nbytes
            if total > max_bytes:
                raise ValueError(
                    "Export exceeds byte budget; partial directory retained"
                )
            path = dest / f"chunk-{i:06d}.npz"
            np.savez(path, signal=data, timestamps=times)
            manifest["chunks"].append(
                {
                    "file": path.name,
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "record": record,
                }
            )
        (dest / "manifest.json").write_bytes(encode(manifest))
        return manifest


def save_dataset(client, session, name, manifest, *, spool):
    if manifest.get("version") != 1 or not manifest.get("sessions"):
        raise ValueError("Dataset manifest v1 needs sessions")
    snapshot = json.loads(encode(manifest))
    digest = hashlib.sha256(encode(snapshot)).hexdigest()
    record = session.record("dataset", 0, name=name, manifest=snapshot, sha256=digest)
    spool.enqueue([record])
    return record["dst"]
