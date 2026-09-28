"""Bounded, reproducible CPU baseline. No pickle loading or server-side user code."""

import hashlib
import json
from pathlib import Path
import time
import zipfile
import numpy as np
from .bci_spool import encode

RECIPE = "csp-lda-v1"
DEFAULTS = {
    "low_hz": 8.0,
    "high_hz": 30.0,
    "epoch_start_s": 0.5,
    "epoch_end_s": 2.5,
    "components": 4,
    "seed": 42,
}


def _epochs(bci, manifest, *, max_bytes=128 * 1024 * 1024):
    expected = manifest.get("source_snapshots", [])
    if len(expected) < 3:
        raise ValueError(
            "Use at least three independent recording sessions; synthetic sessions only demonstrate the workflow"
        )
    cutoffs = {s["session"]: s["through_edge"] for s in expected}
    verified = bci.client.call(
        "bci_manifest",
        {
            "instance": bci.instance,
            "sessions": manifest["sessions"],
            "cutoffs": cutoffs,
            "stream": manifest.get("stream", "eeg"),
        },
    )["manifest"]
    if verified["source_snapshots"] != expected:
        raise ValueError("Dataset source snapshot differs")
    x = []
    y = []
    groups = []
    used = 0
    signature = None
    rejected = {"artifact_or_gap": 0, "invalid_window": 0}
    group_by_participant = len({s["participant"] for s in expected}) >= 3
    stream = manifest.get("stream", "eeg")
    cfg = {**DEFAULTS, **manifest.get("preprocessing", {})}
    if not (
        0 < cfg["low_hz"] < cfg["high_hz"] <= 1000
        and 0 <= cfg["epoch_start_s"] < cfg["epoch_end_s"] <= 10
    ):
        raise ValueError("Invalid bounded preprocessing parameters")
    for snapshot in expected:
        sid = snapshot["session"]
        detail = bci.session(sid)
        meta = next(
            r["fields"] for r in detail["streams"] if r["fields"]["stream_id"] == stream
        )
        eeg = [i for i, k in enumerate(meta["channel_types"]) if k == "EEG"]
        current = (
            meta["channels"],
            meta["units"],
            meta["channel_types"],
            meta["reference"],
            meta["sample_rate_hz"],
        )
        if signature is None:
            signature = current
        if signature != current:
            raise ValueError(
                "Training sessions require identical channels, units, reference and rate"
            )
        rate = float(meta["sample_rate_hz"])
        if not eeg or rate <= 2 * cfg["high_hz"]:
            raise ValueError("Insufficient EEG channels or sample rate for recipe")
        factors = {"V": 1.0, "uV": 1e-6, "µV": 1e-6, "mV": 1e-3}
        if any(meta["units"][i] not in factors for i in eeg):
            raise ValueError("Explicit voltage units are required")
        rows = [
            r
            for r in bci.records(sid)
            if int(r["edge"]) <= int(snapshot["through_edge"])
        ]
        signals = []
        times = []
        events = []
        excluded = []
        for row in rows:
            r = row["record"]
            f = r["fields"]
            if f.get("stream_id") != stream:
                continue
            if f["type"] == "signal":
                d = bci.tensor(r["assets"]["signal"])
                t = bci.tensor(r["assets"]["timestamps"]) + f["correction_seconds"]
                used += d.nbytes + t.nbytes
                if used > max_bytes:
                    raise ValueError(
                        "Dataset exceeds 128 MiB recipe input budget; select shorter recordings"
                    )
                signals.append(
                    d[eeg]
                    * np.asarray([factors[meta["units"][i]] for i in eeg])[:, None]
                )
                times.append(t)
            if f["type"] == "gap" or (
                f["type"] == "event"
                and f.get("category") in ("artifact", "bad_channel")
            ):
                excluded.append((int(r["timestamp_us"]) / 1e6, int(f["end_us"]) / 1e6))
            if f["type"] == "event" and f.get("category") == manifest.get(
                "event_category", "cue"
            ):
                events.append(r)
        if not signals:
            raise ValueError("Selected session contains no signals")
        d = np.concatenate(signals, axis=1)
        t = np.concatenate(times)
        order = np.argsort(t, kind="stable")
        t = t[order]
        d = d[:, order]
        for event in events:
            start = int(event["timestamp_us"]) / 1e6 + cfg["epoch_start_s"]
            end = int(event["timestamp_us"]) / 1e6 + cfg["epoch_end_s"]
            if any(a < end and z >= start for a, z in excluded):
                rejected["artifact_or_gap"] += 1
                continue
            a = np.searchsorted(t, start - 1e-7)
            count = round((end - start) * rate)
            z = a + count
            if (
                z > len(t)
                or abs(t[a] - start) > 1.5 / rate
                or np.any(np.abs(np.diff(t[a:z]) - 1 / rate) > 0.5 / rate)
                or not np.isfinite(d[:, a:z]).all()
            ):
                rejected["invalid_window"] += 1
                continue
            x.append(d[:, a:z])
            y.append(event["fields"]["label"])
            groups.append(snapshot["participant"] if group_by_participant else sid)
    if len(set(groups)) < 3:
        raise ValueError(
            "Need at least three independent groups after excluding gaps/artifacts"
        )
    return np.asarray(x), np.asarray(y), np.asarray(groups), signature, cfg, rejected


def train(bci, manifest, output, *, dataset_id="local", components=4):
    from scipy.signal import butter, sosfilt
    from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
    from sklearn.metrics import (
        balanced_accuracy_score,
        confusion_matrix,
        accuracy_score,
    )
    from mne.decoding import CSP
    import mne, sklearn, scipy

    if type(components) is not int or not 1 <= components <= 16:
        raise ValueError("Components must be 1–16")
    x, y, groups, signature, cfg, rejected = _epochs(bci, manifest)
    if len(set(y)) != 2:
        raise ValueError("The built-in recipe requires exactly two classes")
    unique = sorted(set(groups))
    test_groups = unique[-max(1, len(unique) // 4) :]
    test = np.isin(groups, test_groups)
    fit = ~test
    if (
        min(fit.sum(), test.sum()) < 4
        or len(set(y[fit])) != 2
        or len(set(y[test])) != 2
    ):
        raise ValueError(
            "Independent train/test groups must each contain both classes and at least four valid epochs"
        )
    rate = signature[-1]
    sos = butter(
        4, [cfg["low_hz"], cfg["high_hz"]], btype="bandpass", fs=rate, output="sos"
    )
    # Causal per-window preprocessing, also used by the live decoder. No future
    # samples beyond an epoch and no fitted parameters from evaluation data.
    x = sosfilt(sos, x, axis=-1)
    n = min(components, x.shape[1])
    cfg["components"] = n
    csp = CSP(
        n_components=n, reg="ledoit_wolf", log=True, transform_into="average_power"
    )
    with mne.use_log_level("ERROR"):
        csp.fit(x[fit], y[fit])
    features = csp.transform(x)
    lda = LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto").fit(
        features[fit], y[fit]
    )
    prob = lda.predict_proba(features[test])
    pred = lda.classes_[np.argmax(prob, axis=1)]
    dest = Path(output)
    dest.mkdir(mode=0o700, parents=True, exist_ok=False)
    np.savez(
        dest / "weights.npz",
        filters=csp.filters_[:n],
        coef=lda.coef_,
        intercept=lda.intercept_,
        sos=sos,
    )
    model = {
        "version": 1,
        "recipe": RECIPE,
        "classes": lda.classes_.tolist(),
        "channels": signature[0],
        "units": signature[1],
        "channel_types": signature[2],
        "reference": signature[3],
        "sample_rate_hz": rate,
        "preprocessing": cfg,
        "components": n,
        "weights_sha256": hashlib.sha256(
            (dest / "weights.npz").read_bytes()
        ).hexdigest(),
    }
    (dest / "model.json").write_bytes(encode(model))
    result = {
        "version": 1,
        "recipe": RECIPE,
        "dataset_id": str(dataset_id),
        "manifest_sha256": hashlib.sha256(encode(manifest)).hexdigest(),
        "status": "succeeded",
        "train_epochs": int(fit.sum()),
        "test_epochs": int(test.sum()),
        "test_groups": test_groups,
        "train_groups": [g for g in unique if g not in test_groups],
        "rejected_epochs": rejected,
        "split": "participant when at least three; otherwise session; sorted last quarter held out",
        "accuracy": float(accuracy_score(y[test], pred)),
        "balanced_accuracy": float(balanced_accuracy_score(y[test], pred)),
        "classes": model["classes"],
        "confusion_matrix": confusion_matrix(
            y[test], pred, labels=lda.classes_
        ).tolist(),
        "versions": {
            "mne": mne.__version__,
            "sklearn": sklearn.__version__,
            "scipy": scipy.__version__,
            "numpy": np.__version__,
        },
        "model": model,
    }
    (dest / "result.json").write_bytes(encode(result))
    return result


def predict(model_dir, samples):
    from scipy.signal import sosfilt
    from scipy.special import expit

    root = Path(model_dir)
    if (root / "model.json").stat().st_size > 65536 or (
        root / "weights.npz"
    ).stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Model exceeds bounds")
    model = json.loads((root / "model.json").read_bytes())
    path = root / "weights.npz"
    if (
        model.get("version") != 1
        or model.get("recipe") != RECIPE
        or hashlib.sha256(path.read_bytes()).hexdigest() != model["weights_sha256"]
    ):
        raise ValueError("Untrusted or inconsistent model format")
    with zipfile.ZipFile(path) as z:
        if (
            set(z.namelist())
            != {k + ".npy" for k in ("filters", "coef", "intercept", "sos")}
            or len(z.infolist()) != 4
            or sum(i.file_size for i in z.infolist()) > 8 * 1024 * 1024
        ):
            raise ValueError("Expanded weights exceed limit")
        for entry in z.infolist():
            with z.open(entry) as f:
                version = np.lib.format.read_magic(f)
                if version not in ((1, 0), (2, 0)):
                    raise ValueError("Unsupported weights encoding")
                shape, _, dtype = (
                    np.lib.format.read_array_header_1_0(f)
                    if version == (1, 0)
                    else np.lib.format.read_array_header_2_0(f)
                )
                import math

                if (
                    dtype.hasobject
                    or dtype.kind != "f"
                    or dtype.itemsize not in (4, 8)
                    or len(shape) > 2
                    or math.prod(shape) * dtype.itemsize > entry.file_size - f.tell()
                ):
                    raise ValueError("Invalid bounded weights shape")
    with np.load(path, allow_pickle=False) as w:
        arrays = {k: w[k] for k in ("filters", "coef", "intercept", "sos")}
    if any(not np.isfinite(a).all() for a in arrays.values()):
        raise ValueError("Nonfinite model parameters")
    x = np.asarray(samples, dtype=np.float64)
    eeg = [i for i, k in enumerate(model["channel_types"]) if k == "EEG"]
    expected = round(
        (
            model["preprocessing"]["epoch_end_s"]
            - model["preprocessing"]["epoch_start_s"]
        )
        * model["sample_rate_hz"]
    )
    if x.shape != (len(model["channels"]), expected) or not np.isfinite(x).all():
        raise ValueError(
            "Live window must match model channels, length and finite values"
        )
    factors = {"V": 1, "uV": 1e-6, "µV": 1e-6, "mV": 1e-3}
    x = x[eeg] * np.asarray([factors[model["units"][i]] for i in eeg])[:, None]
    began = time.perf_counter()
    x = sosfilt(arrays["sos"], x, axis=-1)
    feat = np.log(
        np.maximum(np.mean((arrays["filters"] @ x) ** 2, axis=-1), np.finfo(float).tiny)
    )
    p = float(expit((arrays["coef"] @ feat + arrays["intercept"])[0]))
    return {
        "label": model["classes"][int(p >= 0.5)],
        "probability": max(p, 1 - p),
        "latency_ms": (time.perf_counter() - began) * 1000,
    }


def unpack_managed_result(input_path, output):
    """Restore a bounded worker result downloaded from the Managed Runs tab."""
    import base64

    source = Path(input_path)
    if source.stat().st_size > 512 * 1024:
        raise ValueError("Managed result exceeds bounds")
    result = json.loads(source.read_bytes())
    if result.get("status") != "succeeded":
        raise ValueError("Only a successful worker result contains a model")
    artifact = result["artifact"]
    model = artifact["model"]
    weights = base64.b64decode(artifact["weights_base64"], validate=True)
    if (
        len(weights) > 128 * 1024
        or hashlib.sha256(weights).hexdigest() != model["weights_sha256"]
    ):
        raise ValueError("Model checksum mismatch")
    if model.get("version") != 1 or model.get("recipe") != RECIPE:
        raise ValueError("Unsupported model recipe")
    dest = Path(output)
    dest.mkdir(mode=0o700, parents=True, exist_ok=False)
    (dest / "model.json").write_bytes(encode(model))
    (dest / "weights.npz").write_bytes(weights)
    (dest / "result.json").write_bytes(encode(result.get("metrics", {})))
    return {"output": str(dest), "recipe": RECIPE, "image": artifact.get("image")}
