"""Emit a decoder-v1 fixture: the artifact, raw windows and Python's output.

The TypeScript SDK has to reach the same numbers as Python through the shared
WebAssembly module, so this writes both sides of that comparison once and keeps
the fixture identical for either language's test.
"""

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from chronograph_connectors.decoders import portable  # noqa: E402


def build(directory):
    rng = np.random.default_rng(23)
    channels = ["EEG01", "EEG02", "EEG03"]
    bands = [2.0, 10.0, 20.0]
    samples, rate = 128, 250.0
    slots = 2
    vocabulary = ["up", "down", "left", "right"]
    feature_dim = len(channels) * len(bands)
    tensors = {
        "W": rng.normal(0, 0.6, (slots, feature_dim, len(vocabulary))).astype("<f4"),
        "b": rng.normal(0, 0.2, (slots, len(vocabulary))).astype("<f4"),
        "feature_mean": rng.normal(0, 1.0, feature_dim).astype("<f4"),
        "feature_std": (np.abs(rng.normal(1.0, 0.2, feature_dim)) + 0.1).astype("<f4"),
    }
    document = {
        "format": "decoder-v1",
        "adapter": {"name": "wasm-fixture", "version": "1"},
        "kind": "text",
        "sample_rate_hz": rate,
        "channels": channels,
        "window_samples": samples,
        "hop_samples": samples,
        "bands_hz": bands,
        "log_features": True,
        "feature_dim": feature_dim,
        "slots": slots,
        "vocabulary": vocabulary,
        "labels": None,
        "abstain_threshold": 0.0,
        "normalize": True,
        "limits": {"claim": "synthetic parity fixture only"},
        "tensors": [],
    }
    artifact = directory / "artifact"
    portable.save_artifact(artifact, document, tensors)
    windows = rng.normal(0, 2e-5, (5, len(channels), samples))
    expected = portable.run_artifact(artifact, windows)
    for index, window in enumerate(windows):
        path = directory / ("window%d.f64" % index)
        path.write_bytes(np.ascontiguousarray(window, dtype="<f8").tobytes())
    (directory / "expected.json").write_text(json.dumps(expected) + "\n")
    return {
        "windows": len(windows),
        "channels": channels,
        "samples": samples,
        "bands": bands,
    }


def replay(directory, artifact):
    """Write windows and Python's decode for an artifact that already exists.

    Used for the artifact the console ships, so the TypeScript test compares against
    the exact bytes a browser downloads rather than a fixture built beside it.
    """
    rng = np.random.default_rng(41)
    document = json.loads((artifact / "model.json").read_text(encoding="utf-8"))
    channels = document["channels"]
    samples = document["window_samples"]
    windows = rng.normal(0, 2e-5, (3, len(channels), samples))
    expected = portable.run_artifact(artifact, windows)
    for index, window in enumerate(windows):
        (directory / ("window%d.f64" % index)).write_bytes(
            np.ascontiguousarray(window, dtype="<f8").tobytes()
        )
    (directory / "expected.json").write_text(json.dumps(expected) + "\n")
    return {
        "windows": len(windows),
        "channels": channels,
        "samples": samples,
        "adapter": document["adapter"]["name"],
    }


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    out.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 2:
        print(json.dumps(replay(out, Path(sys.argv[2]))))
        return
    print(json.dumps(build(out)))


if __name__ == "__main__":
    main()
