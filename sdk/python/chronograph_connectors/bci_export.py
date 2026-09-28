"""Explicit local derivative exports. Exact source NPZ chunks remain untouched."""

import hashlib
import json
from pathlib import Path
import re
import numpy as np
from .bci_spool import encode


def continuous_raw(directory):
    import mne

    root = Path(directory)
    manifest = json.loads((root / "manifest.json").read_bytes())
    stream = next(
        r["fields"]
        for r in manifest["session"]["streams"]
        if r["fields"]["stream_id"] == manifest["stream"]
    )
    factors = {"V": 1.0, "uV": 1e-6, "µV": 1e-6, "mV": 1e-3}
    if any(u not in factors for u in stream["units"]):
        raise ValueError("MNE export requires explicit voltage units")
    if manifest["gaps"]:
        raise ValueError(
            "Recording contains explicit gaps; use exact chunked export or select a continuous recording"
        )
    values = []
    times = []
    total = 0
    for chunk in manifest["chunks"]:
        name = chunk["file"]
        if not re.fullmatch(r"chunk-\d{6}\.npz", name):
            raise ValueError("Invalid export chunk name")
        path = root / name
        if (
            path.is_symlink()
            or hashlib.sha256(path.read_bytes()).hexdigest() != chunk["sha256"]
        ):
            raise ValueError("Export checksum mismatch")
        with np.load(path, allow_pickle=False) as z:
            data = z["signal"]
            ts = z["timestamps"]
        total += data.nbytes + ts.nbytes
        if total > 512 * 1024 * 1024:
            raise ValueError("MNE export exceeds 512 MiB; use chunked export")
        values.append(data)
        times.append(ts + chunk["record"]["fields"]["correction_seconds"])
    if not values:
        raise ValueError("No samples to export")
    t = np.concatenate(times)
    data = np.concatenate(values, axis=1)
    order = np.argsort(t, kind="stable")
    t = t[order]
    data = data[:, order]
    rate = stream["sample_rate_hz"]
    if np.any(np.abs(np.diff(t) - 1 / rate) > 0.5 / rate):
        raise ValueError(
            "Irregular/discontinuous timestamps require chunked export; no implicit resampling"
        )
    kinds = [t.lower() for t in stream["channel_types"]]
    if any(k not in ("eeg", "eog", "emg", "ecg") for k in kinds):
        raise ValueError("Only explicitly typed voltage channels can be exported")
    raw = mne.io.RawArray(
        data * np.asarray([factors[u] for u in stream["units"]])[:, None],
        mne.create_info(stream["channels"], rate, kinds),
        verbose="ERROR",
    )
    onsets = []
    durations = []
    labels = []
    for item in manifest["events"]:
        r = item["record"]
        f = r["fields"]
        start = int(r["timestamp_us"]) / 1e6
        if t[0] <= start <= t[-1]:
            onsets.append(start - t[0])
            durations.append(max(0, (int(f["end_us"]) - int(r["timestamp_us"])) / 1e6))
            labels.append(
                ("BAD_" if f.get("category") in ("artifact", "bad_channel") else "")
                + f["label"]
            )
    raw.set_annotations(mne.Annotations(onsets, durations, labels))
    return raw, stream, manifest


def fif(directory, output):
    raw, stream, manifest = continuous_raw(directory)
    path = Path(output)
    if path.exists():
        raise ValueError("Output already exists")
    raw.save(path, fmt="double", verbose="ERROR")
    path.with_suffix(".provenance.json").write_bytes(
        encode(
            {
                "version": 1,
                "source_manifest_sha256": hashlib.sha256(
                    (Path(directory) / "manifest.json").read_bytes()
                ).hexdigest(),
                "conversion": "Explicit voltage scaling to SI volts; FIF double precision. Source timestamps and clock records remain in the original chunk manifest.",
                "stream": stream,
            }
        )
    )
    return path


def bids(directory, output, *, subject, task):
    import mne_bids

    if not re.fullmatch("[A-Za-z0-9]+", subject) or not re.fullmatch(
        "[A-Za-z0-9]+", task
    ):
        raise ValueError("BIDS subject/task must be pseudonymous alphanumeric labels")
    raw, stream, manifest = continuous_raw(directory)
    if stream.get("reference") in (None, "", "unspecified"):
        raise ValueError(
            "Provide an explicit EEG reference before requesting BIDS export"
        )
    root = Path(output)
    if root.exists():
        raise ValueError("Output already exists")
    target = mne_bids.BIDSPath(subject=subject, task=task, datatype="eeg", root=root)
    mne_bids.write_raw_bids(
        raw,
        target,
        format="BrainVision",
        allow_preload=True,
        overwrite=False,
        verbose="ERROR",
    )
    sidecar = next(root.glob("sub-*/eeg/*_eeg.json"))
    metadata = json.loads(sidecar.read_text())
    metadata["EEGReference"] = stream["reference"]
    sidecar.write_bytes(encode(metadata))
    # Never invent participant ages, consent, coordinates or device approval.
    (root / "README").write_text(
        "EEG research export from ChronoDB. BrainVision conversion uses float32 SI-scaled data. Retain the exact source NPZ export and its timestamps/provenance separately. Run the official BIDS validator before describing this dataset as BIDS-valid.\n"
    )
    return root
