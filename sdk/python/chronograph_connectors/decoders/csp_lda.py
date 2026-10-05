"""Adapter wrapper around the existing CSP + LDA recipe (csp-lda-v1).

Nothing is reimplemented here; every number comes from
chronograph_connectors.bci_training.

* fit(...) delegates the whole pipeline to bci_training.train(client,
  dataset_manifest, output, ...). That function reads bounded epochs through the
  BCI client, rejects gap/artifact spans and irregular timing, splits by
  participant when at least three participants exist and otherwise by session
  (sorted last quarter held out), filters causally with scipy sosfilt, fits MNE
  CSP plus sklearn LDA and writes model.json and weights.npz. This adapter only
  checks that the epochs the caller passed match the trained model signature.
  Without client/dataset_manifest/output it raises an actionable AdapterError
  instead of silently retraining the recipe from in-memory epochs, because a
  second implementation would change the baseline's behaviour.
* predict(epochs) delegates each epoch to bci_training.predict(model_dir,
  samples). That function re-verifies model.json, the weights sha256, the
  bounded weight shapes, the channel/unit signature and the window length before
  decoding, and it keeps the recipe's causal bandpass, log band power and
  sigmoid LDA probability. The recipe produces no abstention at all, so every
  result reports abstained=False with the top class probability.

The recipe's own checks (two classes, at least three groups, identical channel
signature, 128 MiB input budget) are unchanged and are raised as AdapterError so
callers see one error type from the decoder interface.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np

from .base import AdapterError, DecoderManifest, check_compatible

NAME = "csp-lda-v1"
VERSION = "1"
MAX_MODEL_BYTES = 65536
MAX_WEIGHTS_BYTES = 8 * 1024 * 1024
MAX_EPOCHS = 4096


def _recipe():
    """Import the existing recipe module lazily (it imports numpy only at module level)."""
    from .. import bci_training

    return bci_training


class CSPLDAAdapter:
    """The existing CSP + LDA baseline behind the decoder adapter interface."""

    name = NAME
    version = VERSION

    def __init__(
        self,
        *,
        model_dir=None,
        client=None,
        dataset_manifest=None,
        output=None,
        components=4,
        channels=(),
        sample_rate_hz=0.0,
        epoch_window_s=0.0,
        dataset_id="local",
        limits=None,
    ):
        self._model_dir = None if model_dir is None else str(model_dir)
        self._client = client
        self._dataset_manifest = dataset_manifest
        self._output = None if output is None else str(output)
        self._components = components
        self._dataset_id = str(dataset_id)
        self._channels = tuple(channels)
        self._rate = float(sample_rate_hz)
        self._window = float(epoch_window_s)
        self._extra_limits = dict(limits or {})
        self._last_result = None
        if self._rate < 0 or self._window < 0:
            raise AdapterError("sample_rate_hz and epoch_window_s must not be negative")

    # ---------------------------------------------------------------- internals

    def _read_recipe_model(self):
        """Mirror the bounded model checks bci_training.predict performs."""
        recipe = _recipe()
        root = Path(self._model_dir)
        model_path = root / "model.json"
        weights_path = root / "weights.npz"
        for path, limit in ((model_path, MAX_MODEL_BYTES), (weights_path, MAX_WEIGHTS_BYTES)):
            if path.is_symlink() or not path.is_file():
                raise AdapterError(f"trained recipe directory {root} is missing {path.name}")
            if path.stat().st_size > limit:
                raise AdapterError(f"{path.name} exceeds the recipe bound of {limit} bytes")
        try:
            model = json.loads(model_path.read_bytes())
        except (ValueError, UnicodeDecodeError) as error:
            raise AdapterError(f"{model_path.name} is not valid UTF-8 JSON: {error}") from None
        if not isinstance(model, dict) or model.get("version") != 1 or model.get("recipe") != recipe.RECIPE:
            raise AdapterError(
                f"{root} is not a {recipe.RECIPE} model directory; retrain it with the "
                "existing recipe before loading it here"
            )
        if hashlib.sha256(weights_path.read_bytes()).hexdigest() != model.get("weights_sha256"):
            raise AdapterError(
                "weights.npz does not match the sha256 recorded in model.json; the model is corrupt"
            )
        return model

    @staticmethod
    def _window_samples(model):
        preprocessing = model.get("preprocessing") or {}
        span = float(preprocessing.get("epoch_end_s", 0.0)) - float(
            preprocessing.get("epoch_start_s", 0.0)
        )
        return int(round(span * float(model["sample_rate_hz"])))

    def _common_limits(self):
        recipe = _recipe()
        limits = {
            "recipe": recipe.RECIPE,
            "implementation": "chronograph_connectors.bci_training (unchanged)",
            "delegates_to": {
                "fit": "bci_training.train",
                "predict": "bci_training.predict",
            },
            "abstains": False,
            "real_abstention": "the baseline emits a top class probability only; it never abstains",
            "split": "participant when at least three participants; otherwise session; sorted last quarter held out",
            "preprocessing": "causal scipy sosfilt bandpass per window, log band power over CSP filters",
            "labels": None,
            "claims": [
                "binary classification only; the recipe requires exactly two classes",
                "trained from a recorded dataset served by the BCI client, not from in-memory epochs",
                "no abstention, no text output and no uncertainty calibration beyond the LDA sigmoid",
                "not a clinical or communication-aid claim",
            ],
        }
        limits.update(self._extra_limits)
        return limits

    def _unconfigured_manifest(self):
        recipe = _recipe()
        epoch_window_s = self._window
        if epoch_window_s <= 0:
            defaults = recipe.DEFAULTS
            epoch_window_s = float(defaults["epoch_end_s"] - defaults["epoch_start_s"])
        limits = self._common_limits()
        limits.update(
            {
                "configuration": "untrained",
                "recipe_defaults": dict(recipe.DEFAULTS),
                "epoch_window_s_source": (
                    "configured" if self._window > 0 else "recipe default epoch window"
                ),
                "sample_rate_source": "unknown until a trained model is loaded",
            }
        )
        return DecoderManifest(
            name=NAME,
            version=VERSION,
            kind="classification",
            required_channels=self._channels,
            sample_rate_hz=self._rate,
            epoch_window_s=epoch_window_s,
            vocabulary=None,
            runtime="numpy",
            encoder=None,
            limits=limits,
        )

    def manifest(self):
        """Manifest of the loaded or configured recipe, never a guessed one."""
        if self._model_dir is None:
            return self._unconfigured_manifest()
        model = self._read_recipe_model()
        limits = self._common_limits()
        limits.update(
            {
                "configuration": "trained",
                "labels": list(model["classes"]),
                "components": model.get("components"),
                "preprocessing": model.get("preprocessing"),
                "channel_types": model.get("channel_types"),
                "units": model.get("units"),
                "reference": model.get("reference"),
                "model_directory": self._model_dir,
            }
        )
        return DecoderManifest(
            name=NAME,
            version=VERSION,
            kind="classification",
            required_channels=tuple(model["channels"]),
            sample_rate_hz=float(model["sample_rate_hz"]),
            epoch_window_s=self._window_samples(model) / float(model["sample_rate_hz"]),
            vocabulary=None,
            weights_sha256=str(model["weights_sha256"]),
            runtime="numpy",
            encoder=None,
            limits=limits,
        )

    def labels(self):
        """Class labels of the loaded model, or None when untrained."""
        if self._model_dir is None:
            return None
        return list(self._read_recipe_model()["classes"])

    # ---------------------------------------------------------------- interface

    def fit(self, epochs, labels, groups, *, seed=0):
        """Delegate training to bci_training.train and verify the caller's epochs.

        seed is accepted for interface compatibility and is ignored: the recipe's
        own seed comes from the dataset manifest preprocessing configuration.
        Returns None; the trained model lives in the recipe output directory.
        """
        del seed  # interface-mandated; the recipe seeds itself from its manifest
        if self._client is None or self._dataset_manifest is None or self._output is None:
            raise AdapterError(
                f"{NAME} trains inside the existing bci_training recipe, which reads a recorded "
                "dataset through the BCI client. Construct CSPLDAAdapter(client=..., "
                "dataset_manifest=..., output=...) and retrain there; fitting from in-memory "
                "epochs would require a second pipeline that no longer matches the baseline"
            )
        recipe = _recipe()
        try:
            result = recipe.train(
                self._client,
                self._dataset_manifest,
                self._output,
                dataset_id=self._dataset_id,
                components=self._components,
            )
        except AdapterError:
            raise
        except (ValueError, TypeError, OSError, KeyError) as error:
            raise AdapterError(f"{NAME} training refused the request: {error}") from None
        self._model_dir = self._output
        self._last_result = result
        model = self._read_recipe_model()
        signature = self._signature_of(model)
        if epochs is not None:
            values = np.asarray(epochs)
            if values.dtype.kind != "f" or values.ndim != 3:
                raise AdapterError(
                    "epochs must be a float array shaped (epochs, channels, samples)"
                )
            if values.shape[1:] != signature:
                raise AdapterError(
                    f"trained model expects {signature[0]} channels and {signature[1]} samples; "
                    f"the supplied epochs have {values.shape[1:]}"
                )
        if labels is not None:
            unknown = sorted(set(map(str, labels)) - set(model["classes"]))
            if unknown:
                raise AdapterError(
                    f"labels {unknown[:8]} are outside the trained classes {model['classes']}"
                )
        if groups is not None and len(set(map(str, groups))) < 3:
            raise AdapterError(
                "the recipe requires at least three independent groups (participants or sessions)"
            )

    def _signature_of(self, model):
        return (len(model["channels"]), self._window_samples(model))

    def predict(self, epochs):
        """Delegate every window to bci_training.predict, one call per epoch."""
        if self._model_dir is None:
            raise AdapterError(
                f"{NAME} has no trained model; call fit(...) with a BCI client or construct "
                "CSPLDAAdapter(model_dir=...) from an existing recipe directory"
            )
        recipe = _recipe()
        model = self._read_recipe_model()
        channels, samples = self._signature_of(model)
        array = np.asarray(epochs)
        if array.dtype.kind != "f" or array.dtype.itemsize not in (4, 8):
            raise AdapterError(
                f"predict epochs must be a float32 or float64 array, received {array.dtype}"
            )
        if array.ndim != 3 or array.shape[1:] != (channels, samples):
            raise AdapterError(
                f"{NAME} needs epochs shaped (epochs, {channels}, {samples}), "
                f"received {array.shape}"
            )
        if array.shape[0] < 1 or array.shape[0] > MAX_EPOCHS:
            raise AdapterError(f"predict accepts 1..{MAX_EPOCHS} epochs per call")
        if not np.isfinite(np.asarray(array, dtype=np.float64)).all():
            raise AdapterError("predict epochs contain nonfinite samples")
        check_compatible(self.manifest(), channels, float(model["sample_rate_hz"]))
        results = []
        for index in range(array.shape[0]):
            window = np.asarray(array[index], dtype=np.float64)
            outcome = recipe.predict(self._model_dir, window)
            results.append(
                {
                    "label": str(outcome["label"]),
                    "text": None,
                    "probability": float(outcome["probability"]),
                    "tokens": None,
                    "abstained": False,
                    "latency_ms": float(outcome.get("latency_ms", 0.0)),
                }
            )
        return results


def adapter():
    """Registry factory for the CSP + LDA baseline."""
    return CSPLDAAdapter()
