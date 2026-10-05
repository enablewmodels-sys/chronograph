"""Spec-driven acquisition sources for the BCI research workspace.

Importing this package registers every source and pulls in numpy plus the
standard library only. Optional runtimes stay lazy: mne is imported inside the
recorded-file reader, pylsl inside the LSL source and brainflow inside the board
source and its catalog. Adding a board or EEG file format is a registry row, not
new writer code: implement open() returning StreamPlan(descriptor, chunks) and
call register_source().

run_source() is the single generic writer shared by every source.
"""

# Importing the source modules registers their specs (import side effect only).
from . import brainflow as _brainflow  # noqa: F401
from . import lsl as _lsl  # noqa: F401
from . import mne_file as _mne_file  # noqa: F401
from . import synthetic as _synthetic  # noqa: F401
from . import tabular as _tabular  # noqa: F401
from .base import (
    CLOCK_DOMAINS,
    SOURCES,
    Chunk,
    SourceSpec,
    StreamDescriptor,
    StreamPlan,
    detect,
    register_source,
    run_source,
    source,
    source_ids,
    synthetic_frames,
)

__all__ = [
    "CLOCK_DOMAINS",
    "SOURCES",
    "Chunk",
    "SourceSpec",
    "StreamDescriptor",
    "StreamPlan",
    "detect",
    "register_source",
    "run_source",
    "source",
    "source_ids",
    "synthetic_frames",
]
