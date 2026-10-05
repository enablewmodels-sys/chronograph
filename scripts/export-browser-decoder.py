#!/usr/bin/env python3
"""Ship the browser decoder: the module the console serves and one artifact to run.

A browser must execute the same artifact reader as Python and the native binary, so
this writes both halves into the console's public directory instead of fetching a
model at page load: the WebAssembly module built from crates/chronograph-wasm and a
deterministic reference eeg2text-v1 artifact fitted here. sdk/typescript/test/decoder.mjs
then decodes through exactly these files, which is what makes the claim checkable.

Nothing here is a model claim: the training windows are synthetic and band-coded, and
the artifact exists so a web application can run a decoder without a second
implementation of the arithmetic.
"""

import hashlib
import json
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))

from chronograph_connectors.decoders.eeg2text import EEG2TextDecoder  # noqa: E402

CHANNELS = ("Fz", "Cz", "Pz", "Oz", "C3", "C4", "P3", "P4")
TOKENS = ("up", "down", "left", "right")
SAMPLE_RATE_HZ = 250.0
WINDOW_SAMPLES = 250
BANDS_HZ = (2.0, 6.0, 10.0, 20.0, 40.0)
BAND_INDEX = (0, 1, 2, 3)
GROUPS = ("p01", "p02", "p03", "p04")
PER_GROUP = 16
WASM = ROOT / "target" / "wasm32-unknown-unknown" / "release" / "chronograph_wasm.wasm"
PUBLIC = ROOT / "ui" / "public" / "wasm"


def synthetic(seed=11, noise=3.0, amplitude=24.0):
    """Deterministic windows: token k rides in BANDS_HZ[BAND_INDEX[k]]."""
    rng = np.random.default_rng(seed)
    times = np.arange(WINDOW_SAMPLES, dtype=np.float64) / SAMPLE_RATE_HZ
    windows, labels, ids = [], [], []
    for group in GROUPS:
        for index in range(PER_GROUP):
            which = index % len(TOKENS)
            band = BANDS_HZ[BAND_INDEX[which]]
            window = np.empty((len(CHANNELS), WINDOW_SAMPLES), dtype=np.float32)
            for channel in range(len(CHANNELS)):
                carrier = amplitude * (1.0 - 0.05 * channel) * np.sin(
                    2.0 * np.pi * band * times
                )
                window[channel] = carrier + noise * rng.standard_normal(WINDOW_SAMPLES)
            windows.append(window)
            labels.append(TOKENS[which])
            ids.append(group)
    return np.stack(windows).astype(np.float32), labels, ids


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if not WASM.is_file():
        raise SystemExit(
            "Build the module first: cargo build --release --target "
            "wasm32-unknown-unknown -p chronograph-wasm"
        )
    windows, labels, ids = synthetic()
    # Train on three participant groups and keep the fourth, so the shipped artifact is
    # not fitted on the windows a reviewer is most likely to replay.
    train = [index for index, group in enumerate(ids) if group != GROUPS[-1]]
    decoder = EEG2TextDecoder(
        channels=CHANNELS,
        sample_rate_hz=SAMPLE_RATE_HZ,
        epoch_window_s=1.0,
        vocabulary=list(TOKENS),
        abstain_threshold=0.4,
    )
    decoder.fit(
        windows[train],
        [labels[index] for index in train],
        [ids[index] for index in train],
        vocabulary=list(TOKENS),
    )
    (PUBLIC / "artifact").mkdir(parents=True, exist_ok=True)
    decoder.save(PUBLIC / "artifact")
    shutil.copyfile(WASM, PUBLIC / "chronograph-decoder.wasm")
    described = json.loads((PUBLIC / "artifact" / "model.json").read_text("utf-8"))
    print(
        json.dumps(
            {
                "written": str(PUBLIC.relative_to(ROOT)),
                "module_bytes": (PUBLIC / "chronograph-decoder.wasm").stat().st_size,
                "module_sha256": sha256(PUBLIC / "chronograph-decoder.wasm"),
                "artifact_sha256": sha256(PUBLIC / "artifact" / "weights.bin"),
                "adapter": described["adapter"]["name"],
                "channels": len(described["channels"]),
                "vocabulary": len(described["vocabulary"]),
                "training_windows": len(train),
                "note": "synthetic band-coded fixture; plumbing evidence, not a model claim",
            }
        )
    )


if __name__ == "__main__":
    main()
