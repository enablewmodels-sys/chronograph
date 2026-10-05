"""Python and Rust must agree on the same portable decoder artifact."""

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

BINARY = Path(
    os.environ.get("CHRONOGRAPH_DECODE_BIN", ROOT / "target" / "debug" / "chronograph-decode")
)


def main():
    if not BINARY.is_file():
        raise SystemExit(
            "Build the executor first: "
            "cargo build -p chronograph-decoder --bins (missing " + str(BINARY) + ")"
        )
    rng = np.random.default_rng(11)
    channels = ["EEG01", "EEG02", "EEG03", "EEG04"]
    bands = [2.0, 6.0, 10.0, 20.0]
    samples, rate, slots = 250, 250.0, 3
    vocabulary = ["up", "down", "left", "right", "stop"]
    feature_dim = len(channels) * len(bands)
    tensors = {
        "W": rng.normal(0, 0.5, (slots, feature_dim, len(vocabulary))).astype("<f4"),
        "b": rng.normal(0, 0.1, (slots, len(vocabulary))).astype("<f4"),
        "feature_mean": rng.normal(0, 1.0, feature_dim).astype("<f4"),
        "feature_std": (np.abs(rng.normal(1.0, 0.2, feature_dim)) + 0.1).astype("<f4"),
    }
    document = {
        "format": "decoder-v1",
        "adapter": {"name": "parity-fixture", "version": "1"},
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
        "limits": {"claim": "synthetic parity fixture only; no model-quality claim"},
        # save_artifact fills this in; the document is validated before publication.
        "tensors": [],
    }
    with tempfile.TemporaryDirectory(prefix="chronograph-parity-") as work:
        root = Path(work)
        artifact = root / "artifact"
        portable.save_artifact(artifact, document, tensors)
        windows = rng.normal(0, 2e-5, (8, len(channels), samples)).astype("<f4")
        expected = portable.run_artifact(artifact, windows)
        described = json.loads(
            subprocess.run(
                [str(BINARY), "--artifact", str(artifact), "--describe"],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        assert described["channels"] == len(channels), described
        assert described["channel_names"] == channels, described
        assert described["window_samples"] == samples, described
        assert described["sample_rate_hz"] == rate, described
        assert described["adapter"] == "parity-fixture", described
        worst = 0.0
        for index, window in enumerate(windows):
            path = root / ("window%d.f32" % index)
            path.write_bytes(np.ascontiguousarray(window, dtype="<f4").tobytes())
            completed = subprocess.run(
                [str(BINARY), "--artifact", str(artifact), "--input", str(path)],
                capture_output=True,
                text=True,
            )
            assert completed.returncode == 0, completed.stderr
            rust = json.loads(completed.stdout)
            reference = expected[index]
            assert rust["text"] == reference["text"], (rust, reference)
            assert rust["abstained"] == reference["abstained"], (rust, reference)
            assert len(rust["tokens"]) == len(reference["tokens"])
            for produced, wanted in zip(rust["tokens"], reference["tokens"]):
                assert produced["slot"] == wanted["slot"]
                assert produced["token"] == wanted["token"], (produced, wanted)
                assert produced["abstained"] == wanted["abstained"]
                gap = abs(produced["probability"] - wanted["probability"])
                worst = max(worst, gap)
                assert gap < 1e-9, (produced, wanted)
            gap = abs(rust["probability"] - reference["probability"])
            worst = max(worst, gap)
            assert gap < 1e-9, (rust, reference)
        # A malformed input is rejected with a nonzero exit, not decoded anyway.
        bad = root / "bad.f32"
        bad.write_bytes(b"\x00" * 8)
        failed = subprocess.run(
            [str(BINARY), "--artifact", str(artifact), "--input", str(bad)],
            capture_output=True,
            text=True,
        )
        assert failed.returncode != 0, failed.stdout
        print(
            json.dumps(
                {
                    "passed": True,
                    "windows": len(windows),
                    "slots": slots,
                    "vocabulary": len(vocabulary),
                    "max_probability_delta": worst,
                    "tokens_equal": True,
                    "rejected_malformed_input": True,
                    "note": "synthetic fixture; parity statement only, no model claim",
                }
            )
        )


if __name__ == "__main__":
    main()
