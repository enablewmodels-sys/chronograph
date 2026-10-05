"""Python, native Rust and WebAssembly must decode one artifact identically."""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from chronograph_connectors.decoders import portable  # noqa: E402

NODE = os.environ.get("CHRONOGRAPH_NODE", "node")
WASM = Path(
    os.environ.get(
        "CHRONOGRAPH_WASM",
        ROOT / "target" / "wasm32-unknown-unknown" / "release" / "chronograph_wasm.wasm",
    )
)


def main():
    if not WASM.is_file():
        raise SystemExit(
            "Build the module first: cargo build --release --target "
            "wasm32-unknown-unknown -p chronograph-wasm"
        )
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
    with tempfile.TemporaryDirectory(prefix="chronograph-wasm-") as work:
        root = Path(work)
        artifact = root / "artifact"
        portable.save_artifact(artifact, document, tensors)
        windows = rng.normal(0, 2e-5, (5, len(channels), samples))
        expected = portable.run_artifact(artifact, windows)
        worst = 0.0
        for index, window in enumerate(windows):
            path = root / ("window%d.f64" % index)
            path.write_bytes(np.ascontiguousarray(window, dtype="<f8").tobytes())
            completed = subprocess.run(
                [
                    NODE,
                    str(ROOT / "scripts" / "decoder-wasm-harness.mjs"),
                    str(WASM),
                    str(artifact),
                    str(path),
                ],
                capture_output=True,
                text=True,
            )
            if completed.returncode != 0:
                raise SystemExit(
                    "wasm harness failed: " + completed.stderr.strip()[:400]
                )
            produced = json.loads(completed.stdout)
            description = produced["describe"]
            rust = produced["decoded"]
            reference = expected[index]
            assert description["adapter"] == "wasm-fixture", description
            assert description["channel_names"] == channels, description
            assert description["window_samples"] == samples, description
            assert rust["text"] == reference["text"], (rust, reference)
            assert rust["abstained"] == reference["abstained"], (rust, reference)
            for got, want in zip(rust["tokens"], reference["tokens"]):
                assert got["token"] == want["token"], (got, want)
                assert got["slot"] == want["slot"]
                gap = abs(got["probability"] - want["probability"])
                worst = max(worst, gap)
                assert gap < 1e-9, (got, want)
            gap = abs(rust["probability"] - reference["probability"])
            worst = max(worst, gap)
            assert gap < 1e-9, (rust, reference)
        print(
            json.dumps(
                {
                    "passed": True,
                    "windows": len(windows),
                    "tokens_equal": True,
                    "max_probability_delta": worst,
                    "module_bytes": WASM.stat().st_size,
                    "note": "Python and WebAssembly, synthetic fixture only",
                }
            )
        )


if __name__ == "__main__":
    main()
