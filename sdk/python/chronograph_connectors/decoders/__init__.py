"""Pluggable decoder adapters, the decoder-v1 artifact and the eeg2text reference.

Public surface:

* Adapter interface: DecoderAdapter, DecoderManifest, AdapterError,
  check_compatible, describe_required, group_holdout.
* Registry: register_decoder, unregister_decoder, decoder, decoders,
  describe_all, refresh, ENTRY_POINT_GROUP (entry-point group
  "chronograph.decoders").
* Shared features: band_features, window_signal, hann_window, band_list,
  feature_dim.
* Portable artifact: save_artifact, load_artifact, run_artifact,
  decode_features, canonical_weights_sha256, to_manifest, FORMAT.
* Implementations: EEG2TextDecoder (eeg2text-v1) and CSPLDAAdapter
  (csp-lda-v1, a wrapper over the existing bci_training recipe).

Importing this package pulls in NumPy only. scipy, sklearn and mne are imported
lazily by the code that actually needs them, so registering or listing decoders
stays cheap.
"""

from .base import (
    KINDS,
    MAX_CHANNELS,
    AdapterError,
    DecoderAdapter,
    DecoderManifest,
    check_compatible,
    describe_required,
    group_holdout,
)
from .csp_lda import CSPLDAAdapter
from .eeg2text import (
    DEFAULT_BANDS_HZ,
    DEFAULT_VOCABULARY,
    EEG2TextDecoder,
    load_vocabulary,
)
from .features import band_features, band_list, feature_dim, hann_window, window_signal
from .portable import (
    FORMAT,
    canonical_weights_sha256,
    decode_features,
    load_artifact,
    run_artifact,
    save_artifact,
    to_manifest,
)
from .registry import (
    ENTRY_POINT_GROUP,
    decoder,
    decoders,
    describe_all,
    refresh,
    register_decoder,
    unregister_decoder,
)

__all__ = [
    "AdapterError",
    "CSPLDAAdapter",
    "DEFAULT_BANDS_HZ",
    "DEFAULT_VOCABULARY",
    "DecoderAdapter",
    "DecoderManifest",
    "EEG2TextDecoder",
    "ENTRY_POINT_GROUP",
    "FORMAT",
    "KINDS",
    "MAX_CHANNELS",
    "band_features",
    "band_list",
    "canonical_weights_sha256",
    "check_compatible",
    "decode_features",
    "decoder",
    "decoders",
    "describe_all",
    "describe_required",
    "feature_dim",
    "group_holdout",
    "hann_window",
    "load_artifact",
    "load_vocabulary",
    "refresh",
    "register_decoder",
    "run_artifact",
    "save_artifact",
    "to_manifest",
    "unregister_decoder",
    "window_signal",
]
