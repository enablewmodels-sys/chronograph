"""Synthetic plumbing checks for the pluggable decoder interface.

No hardware and no server are used. Every number printed here comes from
synthetic data: it proves the interface, the artifact bytes, the abstention rule
and the registry behave, and it is not evidence about human EEG decoding
accuracy.

Run:
    cd <repo> && PYTHONPATH=sdk/python .work/connector-v04-python/bin/python scripts/bci-decoder-test.py
"""

import hashlib
import importlib.metadata
import json
import sys
import tempfile
from pathlib import Path

import numpy as np
from chronograph_connectors.decoders import (
    DEFAULT_VOCABULARY,
    AdapterError,
    DecoderManifest,
    EEG2TextDecoder,
    check_compatible,
    decoder,
    decoders,
    describe_all,
    group_holdout,
    load_artifact,
    load_vocabulary,
    register_decoder,
    registry,
    run_artifact,
    unregister_decoder,
)

SAMPLE_RATE_HZ = 250.0
WINDOW_SAMPLES = 250
CHANNELS = ("Fz", "Cz", "Pz", "Oz", "C3", "C4", "P3", "P4")
BANDS_HZ = (2.0, 6.0, 10.0, 20.0, 40.0)
TOKENS = ("up", "down", "left", "right")
TOKENS_ALT = ("red", "green", "blue", "yellow")
BAND_INDEX = (0, 1, 2, 3)
GROUPS = ("p01", "p02", "p03", "p04")
PER_GROUP = 16
CHANCE = 1.0 / len(TOKENS)


def step(number, text):
    print(f"[{number}] {text}")
    sys.stdout.flush()


def synthetic(tokens=TOKENS, *, seed=11, noise=3.0, amplitude=24.0, groups=GROUPS, per_group=PER_GROUP):
    """Deterministic synthetic windows: token k is carried by BANDS_HZ[BAND_INDEX[k]]."""
    rng = np.random.default_rng(seed)
    times = np.arange(WINDOW_SAMPLES, dtype=np.float64) / SAMPLE_RATE_HZ
    windows, labels, ids = [], [], []
    for group in groups:
        for index in range(per_group):
            which = index % len(tokens)
            band = BANDS_HZ[BAND_INDEX[which]]
            window = np.empty((len(CHANNELS), WINDOW_SAMPLES), dtype=np.float32)
            for channel in range(len(CHANNELS)):
                carrier = amplitude * (1.0 - 0.05 * channel) * np.sin(2.0 * np.pi * band * times)
                window[channel] = carrier + noise * rng.standard_normal(WINDOW_SAMPLES)
            windows.append(window)
            labels.append(tokens[which])
            ids.append(group)
    return np.stack(windows).astype(np.float32), labels, ids


def expect_error(call, needle, what):
    try:
        call()
    except AdapterError as error:
        message = str(error)
        assert needle in message, f"{what}: expected {needle!r} in {message!r}"
        return message
    raise AssertionError(f"{what}: expected an AdapterError, none was raised")


def accuracy(predictions, truth):
    hits = sum(1 for prediction, token in zip(predictions, truth, strict=True) if prediction["text"] == token)
    return hits / len(truth)


workspace = Path(tempfile.mkdtemp(prefix="bci-decoder-test-"))

# ---------------------------------------------------------------- 1. registry
step(1, "registry lists both built-ins and describe_all exposes manifest fields")
names = decoders()
for expected in ("csp-lda-v1", "eeg2text-v1"):
    assert expected in names, f"{expected} missing from {names}"
records = {record["name"]: record for record in describe_all()}
required_fields = {
    "name",
    "version",
    "kind",
    "required_channels",
    "sample_rate_hz",
    "epoch_window_s",
    "vocabulary",
    "weights_sha256",
    "runtime",
    "encoder",
    "limits",
}
for name in ("csp-lda-v1", "eeg2text-v1"):
    record = records[name]
    assert record["available"] is True, record
    missing = required_fields - set(record)
    assert not missing, f"{name} describe_all record is missing {sorted(missing)}"
assert records["eeg2text-v1"]["kind"] == "text"
assert records["eeg2text-v1"]["sample_rate_hz"] == SAMPLE_RATE_HZ
assert tuple(records["eeg2text-v1"]["vocabulary"]) == DEFAULT_VOCABULARY
assert records["csp-lda-v1"]["kind"] == "classification"
assert records["csp-lda-v1"]["limits"]["delegates_to"]["fit"] == "bci_training.train"
print(f"    decoders() = {names}")
print(f"    eeg2text-v1: kind=text rate={records['eeg2text-v1']['sample_rate_hz']} "
      f"vocabulary={len(records['eeg2text-v1']['vocabulary'])} tokens")
print(f"    csp-lda-v1 : kind=classification configuration="
      f"{records['csp-lda-v1']['limits']['configuration']} (no model loaded, no server needed)")

# ------------------------------------------------- 2. fit/predict by held-out group
step(2, "fit on 3 participant groups, decode a held-out group, compare with chance")
windows, labels, ids = synthetic()
train_index, holdout_index = group_holdout(ids)
held_out_groups = {ids[i] for i in holdout_index}
assert not held_out_groups & {ids[i] for i in train_index}
MANIFEST_VOCABULARY = TOKENS[:4]


def fitted(threshold, *, vocabulary=MANIFEST_VOCABULARY, windows_=None, labels_=None, ids_=None):
    source = windows if windows_ is None else windows_
    source_labels = labels if labels_ is None else labels_
    source_ids = ids if ids_ is None else ids_
    adapter = EEG2TextDecoder(
        channels=CHANNELS,
        sample_rate_hz=SAMPLE_RATE_HZ,
        epoch_window_s=1.0,
        vocabulary=vocabulary,
        abstain_threshold=threshold,
    )
    adapter.fit(
        source[train_index],
        [source_labels[i] for i in train_index],
        [source_ids[i] for i in train_index],
        vocabulary=vocabulary,
    )
    return adapter


model = fitted(0.4)
check_compatible(model.manifest(), CHANNELS, SAMPLE_RATE_HZ)
held_out = model.predict(windows[holdout_index])
truth = [labels[i] for i in holdout_index]
score = accuracy(held_out, truth)
assert score > 3 * CHANCE, f"held-out accuracy {score} is not clearly above chance {CHANCE}"
assert all(prediction["label"] is None for prediction in held_out)
assert all(prediction["tokens"][0]["slot"] == 0 for prediction in held_out)
assert all(0.0 <= prediction["probability"] <= 1.0 for prediction in held_out)
assert sum(1 for prediction in held_out if prediction["abstained"]) == 0
manifest = model.manifest()
assert manifest.weights_sha256 is not None and len(manifest.weights_sha256) == 64
assert manifest.required_channels == CHANNELS
assert tuple(manifest.vocabulary) == MANIFEST_VOCABULARY
assert manifest.limits["train_epochs"] == len(train_index)
assert manifest.limits["train_groups"] == sorted({ids[i] for i in train_index})
trained_groups = sorted({ids[i] for i in train_index})
print(f"    train windows={len(train_index)} groups={trained_groups}")
print(f"    held-out windows={len(holdout_index)} groups={sorted(held_out_groups)}")
print(f"    held-out token accuracy = {score:.3f} (chance {CHANCE:.3f}, "
      f"{score / CHANCE:.1f}x chance) on synthetic data")

# ---------------------------------------------------------------- 3. abstention
step(3, "abstention is a pure confidence gate on the same fitted weights")
sweep = {}
for threshold in (0.0, 0.4, 0.6, 0.99):
    adapter = model if threshold == 0.4 else fitted(threshold)
    results = adapter.predict(windows[holdout_index])
    sweep[threshold] = results
    assert adapter.manifest().limits["abstain_threshold"] == threshold
permissive = sweep[0.0]
abstained = sweep[0.99]
assert not any(prediction["abstained"] for prediction in permissive)
assert not any("<abstain>" in prediction["text"] for prediction in permissive)
assert all(prediction["abstained"] for prediction in abstained)
assert all(token["abstained"] for prediction in abstained for token in prediction["tokens"])
assert all(prediction["text"] == "<abstain>" for prediction in abstained)
assert [p["tokens"][0]["token"] for p in permissive] != [None] * len(permissive)
assert [p["tokens"][0]["token"] for p in abstained] == [None] * len(abstained)
assert [p["text"] for p in sweep[0.4]] == [p["text"] for p in permissive]
winner = [prediction["tokens"][0]["probability"] for prediction in permissive]
print("    threshold -> windows abstained / " + str(len(permissive)))
for threshold in (0.0, 0.4, 0.6, 0.99):
    count = sum(1 for prediction in sweep[threshold] if prediction["abstained"])
    print(f"      {threshold:<5} -> {count}/{len(permissive)} abstained, "
          f"text sample {sweep[threshold][0]['text']!r}")
print(f"    same weights, same windows: winning probability ranges "
      f"{min(winner):.3f}..{max(winner):.3f}; the 0.99 gate abstains, 0.0 and 0.4 decode")

# ------------------------------------------------------------ 4. vocabulary swap
step(4, "swapping the vocabulary changes the manifest and the decoded text")
alt_windows, alt_labels, alt_ids = synthetic(tokens=TOKENS_ALT, seed=11)
swapped = EEG2TextDecoder(
    channels=CHANNELS,
    sample_rate_hz=SAMPLE_RATE_HZ,
    vocabulary=TOKENS_ALT,
    abstain_threshold=0.4,
)
swapped.fit(
    alt_windows[train_index],
    [alt_labels[i] for i in train_index],
    [alt_ids[i] for i in train_index],
    vocabulary=TOKENS_ALT,
)
assert tuple(swapped.manifest().vocabulary) == TOKENS_ALT
assert tuple(swapped.manifest().vocabulary) != DEFAULT_VOCABULARY
swapped_predictions = swapped.predict(alt_windows[holdout_index])
swapped_truth = [alt_labels[i] for i in holdout_index]
swapped_score = accuracy(swapped_predictions, swapped_truth)
assert swapped_score > 3 * CHANCE, swapped_score
decoded_tokens = {token for p in swapped_predictions for token in p["text"].split()}
assert decoded_tokens and decoded_tokens <= set(TOKENS_ALT), decoded_tokens
missing_swap = expect_error(
    lambda: EEG2TextDecoder(channels=CHANNELS, sample_rate_hz=SAMPLE_RATE_HZ).fit(
        alt_windows[train_index],
        [alt_labels[i] for i in train_index],
        [alt_ids[i] for i in train_index],
    ),
    "outside the vocabulary",
    "labels from another vocabulary without the swap",
)
vocabulary_file = workspace / "vocabulary.json"
vocabulary_file.write_bytes(json.dumps({"vocabulary": list(TOKENS_ALT)}).encode())
assert load_vocabulary(vocabulary_file) == TOKENS_ALT
bad_vocabulary_file = workspace / "bad-vocabulary.json"
bad_vocabulary_file.write_bytes(b'{"vocabulary": [1, 2]}')
expect_error(
    lambda: load_vocabulary(bad_vocabulary_file),
    "nonempty string",
    "invalid vocabulary file",
)
print(f"    manifest vocabulary -> {list(swapped.manifest().vocabulary)}")
print(f"    decoded tokens on held-out windows -> {sorted(decoded_tokens)}")
print(f"    held-out accuracy with the swapped vocabulary = {swapped_score:.3f}")
print(f"    without the swap the same fit refuses: {missing_swap[:72]}...")

# --------------------------------------------------------- 5. check_compatible
step(5, "check_compatible rejects the wrong montage, order and rate")
wide = EEG2TextDecoder(
    channels=tuple(f"EEG{index:03d}" for index in range(128)),
    sample_rate_hz=1000.0,
)
count_message = expect_error(
    lambda: check_compatible(wide.manifest(), CHANNELS, SAMPLE_RATE_HZ),
    "128",
    "128-channel requirement against 8 channels",
)
assert "8" in count_message
rate_message = expect_error(
    lambda: check_compatible(
        wide.manifest(), tuple(f"EEG{index:03d}" for index in range(128)), SAMPLE_RATE_HZ
    ),
    "1000",
    "rate mismatch",
)
assert "250" in rate_message
permuted = (CHANNELS[1], CHANNELS[0]) + CHANNELS[2:]
order_message = expect_error(
    lambda: check_compatible(model.manifest(), permuted, SAMPLE_RATE_HZ),
    "exact channel order",
    "channel order mismatch",
)
check_compatible(model.manifest(), CHANNELS, SAMPLE_RATE_HZ)
window_message = expect_error(
    lambda: model.predict(windows[holdout_index][:, :, :200]),
    "250",
    "wrong window length at predict time",
)
assert "200" in window_message
print(f"    128-channel case  : {count_message[:96]}...")
print(f"    rate mismatch     : {rate_message[:96]}...")
print(f"    channel order case: {order_message[:96]}...")
print(f"    predict window    : {window_message[:96]}...")

# ------------------------------------------------- 6. third-party registration
step(6, "third-party factories and a broken entry point never break the registry")


class FixtureAdapter:
    """Third-party style fixture defined in this test file, not part of the SDK."""

    decoder_name = "fixture-third-party"

    def __init__(self, *, label="fixture"):
        self._label = label

    def manifest(self):
        return DecoderManifest(
            name="fixture-third-party",
            version="1",
            kind="classification",
            required_channels=CHANNELS,
            sample_rate_hz=SAMPLE_RATE_HZ,
            epoch_window_s=1.0,
            vocabulary=None,
            weights_sha256=None,
            runtime="numpy-fixture",
            encoder=None,
            limits={
                "purpose": "registry plumbing fixture",
                "labels": ["left", "right"],
                "claims": ["test fixture only; not a model"],
            },
        )

    def fit(self, epochs, labels, groups, *, seed=0):
        del groups, seed  # interface-mandated: this fixture ignores groups and seed
        self._seen = (len(epochs), sorted(set(map(str, labels))))

    def predict(self, epochs):
        return [
            {
                "label": self._label,
                "text": None,
                "probability": 1.0,
                "tokens": None,
                "abstained": False,
            }
            for _ in range(len(epochs))
        ]


register_decoder(name="fixture-third-party")(FixtureAdapter)


@register_decoder
def fixture_decorated():
    return FixtureAdapter(label="decorated")


for name in ("fixture-third-party", "fixture_decorated"):
    assert name in decoders(), name
    assert decoder(name).manifest().required_channels == CHANNELS
fixture_record = {record["name"]: record for record in describe_all()}["fixture-third-party"]
assert fixture_record["available"] is True and fixture_record["source"] == "registered"


class BrokenEntryPoint:
    name = "fixture-broken"
    value = "fixture_broken:factory"
    group = registry.ENTRY_POINT_GROUP

    def load(self):
        raise ImportError("fixture: module 'fixture_broken' is not installed")


class WorkingEntryPoint:
    name = "fixture-entry-point"
    value = "synthetic-fixture:FixtureAdapter"
    group = registry.ENTRY_POINT_GROUP

    def load(self):
        return FixtureAdapter


real_entry_points = importlib.metadata.entry_points


def fake_entry_points(*args, **kwargs):
    group = kwargs.get("group")
    if group is None and args:
        group = args[0]
    if group == registry.ENTRY_POINT_GROUP:
        return [BrokenEntryPoint(), WorkingEntryPoint()]
    return real_entry_points(*args, **kwargs)


importlib.metadata.entry_points = fake_entry_points
try:
    registry.refresh()
    discovered = decoders()
    assert "fixture-broken" in discovered and "fixture-entry-point" in discovered, discovered
    discovered_records = {record["name"]: record for record in describe_all()}
    broken = discovered_records["fixture-broken"]
    assert broken["available"] is False
    assert "not installed" in broken["error"]
    assert discovered_records["fixture-entry-point"]["available"] is True
    assert discovered_records["fixture-entry-point"]["kind"] == "classification"
    assert decoder("fixture-entry-point").manifest().name == "fixture-third-party"
    broken_message = expect_error(
        lambda: decoder("fixture-broken"), "not installed", "broken entry point"
    )
    assert {"csp-lda-v1", "eeg2text-v1"} <= set(discovered)
finally:
    importlib.metadata.entry_points = real_entry_points
    registry.refresh()
assert "fixture-broken" not in decoders()
assert "fixture-entry-point" not in decoders()
assert unregister_decoder("fixture-third-party") is True
assert unregister_decoder("fixture_decorated") is True
assert "fixture-third-party" not in decoders()
print(f"    registered fixture visible: {sorted(set(discovered) - set(names))}")
print(f"    broken entry point record : available={broken['available']} error={broken['error'][:60]}...")
print(f"    decoder('fixture-broken') -> AdapterError: {broken_message[:60]}...")

# ----------------------------------------------------- 7. portable artifact
step(7, "decoder-v1 artifact: checksums, corruption, truncation, executor identity")
artifact = workspace / "eeg2text-v1"
saved = model.save(artifact)
assert saved == str(artifact)
document, tensors = load_artifact(artifact)
assert document["format"] == "decoder-v1"
assert document["kind"] == "text"
assert document["adapter"] == {"name": "eeg2text-v1", "version": "1"}
assert document["channels"] == list(CHANNELS)
assert document["bands_hz"] == list(BANDS_HZ)
assert document["window_samples"] == WINDOW_SAMPLES and document["hop_samples"] == 125
assert document["feature_dim"] == len(CHANNELS) * len(BANDS_HZ)
assert document["slots"] == 1 and document["normalize"] is True
assert document["log_features"] is True and document["labels"] is None
assert document["vocabulary"] == list(TOKENS)
assert document["abstain_threshold"] == 0.4
assert set(tensors) == {"W", "b", "feature_mean", "feature_std"}
weight_bytes = np.ascontiguousarray(tensors["W"]).astype("<f4").tobytes(order="C")
bias_bytes = np.ascontiguousarray(tensors["b"]).astype("<f4").tobytes(order="C")
assert hashlib.sha256(weight_bytes + bias_bytes).hexdigest() == model.manifest().weights_sha256
offsets = [(record["name"], record["offset"], record["bytes"]) for record in document["tensors"]]
assert offsets[0] == ("W", 0, len(weight_bytes)), offsets
assert offsets[1] == ("b", len(weight_bytes), len(bias_bytes)), offsets
for record in document["tensors"]:
    payload = (artifact / "weights.bin").read_bytes()[
        record["offset"] : record["offset"] + record["bytes"]
    ]
    assert hashlib.sha256(payload).hexdigest() == record["sha256"], record["name"]
from_artifact = run_artifact(artifact, windows[holdout_index])
from_method = model.predict_windows(windows[holdout_index])
from_memory = model.predict(windows[holdout_index])
for left, middle, right in zip(from_artifact, from_method, from_memory, strict=True):
    for pair in ((left, middle), (left, right)):
        assert pair[0]["text"] == pair[1]["text"] == left["text"]
        assert abs(pair[0]["probability"] - pair[1]["probability"]) <= 1e-9
        for one, two in zip(pair[0]["tokens"], pair[1]["tokens"], strict=True):
            assert one["token"] == two["token"] and one["slot"] == two["slot"]
            assert abs(one["probability"] - two["probability"]) <= 1e-9
reloaded = EEG2TextDecoder.load(artifact)
assert reloaded.manifest().required_channels == CHANNELS
assert reloaded.manifest().weights_sha256 == model.manifest().weights_sha256
assert tuple(reloaded.manifest().vocabulary) == tuple(model.manifest().vocabulary)
reloaded_predictions = reloaded.predict(windows[holdout_index])
assert [p["text"] for p in reloaded_predictions] == [p["text"] for p in from_memory]
assert max(
    abs(a["probability"] - b["probability"]) for a, b in zip(reloaded_predictions, from_memory, strict=True)
) <= 1e-9
assert accuracy(reloaded_predictions, truth) == score

weights_path = artifact / "weights.bin"
model_path = artifact / "model.json"
good_weights = weights_path.read_bytes()
good_model = model_path.read_bytes()
corrupted = bytearray(good_weights)
corrupted[4] ^= 0xFF
weights_path.write_bytes(bytes(corrupted))
corrupt_message = expect_error(lambda: load_artifact(artifact), "sha256", "corrupted weight byte")
weights_path.write_bytes(good_weights[:-1])
short_message = expect_error(lambda: load_artifact(artifact), "beyond", "weights.bin truncated by one byte")
weights_path.write_bytes(good_weights[:8])
tiny_message = expect_error(lambda: load_artifact(artifact), "beyond", "weights.bin truncated to 8 bytes")
weights_path.write_bytes(good_weights)
tampered = json.loads(good_model)
tampered["tensors"][1]["offset"] = tampered["tensors"][0]["offset"]
model_path.write_bytes(json.dumps(tampered).encode())
overlap_message = expect_error(lambda: load_artifact(artifact), "overlap", "duplicate byte range")
tampered_bytes = json.loads(good_model)
tampered_bytes["tensors"][0]["sha256"] = "0" * 64
model_path.write_bytes(json.dumps(tampered_bytes).encode())
document_message = expect_error(lambda: load_artifact(artifact), "sha256", "forged tensor digest")
model_path.write_bytes(good_model)
assert load_artifact(artifact)[1]["W"].shape == (1, len(CHANNELS) * len(BANDS_HZ), len(TOKENS))
print(f"    run_artifact == predict_windows == predict for {len(from_artifact)} windows "
      f"(tokens identical, probabilities within 1e-9)")
print(f"    corrupted byte  -> {corrupt_message[:66]}...")
print(f"    truncated file  -> {short_message[:66]}...")
print(f"    short file      -> {tiny_message[:66]}...")
print(f"    overlapping span-> {overlap_message[:66]}...")
print(f"    forged digest   -> {document_message[:66]}...")

# ------------------------------------------------------------- 8. paths and OK
step(8, "artifact files, sizes and final status")
total = 0
for path in sorted(artifact.rglob("*")):
    size = path.stat().st_size
    total += size
    print(f"    {path}  {size} bytes")
print(f"    artifact total {total} bytes in {artifact}")
print(f"    synthetic plumbing checks only: held-out accuracy {score:.3f} on {len(held_out_groups)} "
      f"unseen synthetic participant group(s); no human data, no model claim")
print("OK")
