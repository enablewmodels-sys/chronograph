"""Tabular and array files: CSV, TSV, NPY, OpenBCI TXT and BrainFlow CSV.

Nothing is inferred. The caller states the channel names and order, one explicit
unit per channel, the sample rate, the start timestamp and the file layout:

  layout="samples_channels"  each row is one sample, one column per channel
  layout="channels_samples"  each row is one channel, one column per sample

Delimited text is parsed with the standard library csv module only. Blank rows
and comment rows (first cell starting with # or %) are skipped. A leading header
row is handled explicitly: has_header=True drops the first data row,
has_header=False keeps every row, and has_header=None drops the first row only
when a structural check finds a non-numeric token in it (no unit or rate is ever
read from that row). skip_columns and trailing_columns drop leading and trailing
row columns such as an OpenBCI "Sample Index" and its Timestamp/Marker tail.
time_column names one retained column (absolute row index) that carries source
seconds verbatim; without it, timestamps are reconstructed from the explicit
start_us and sample_rate_hz and never converted.

Units are demanded, never guessed: passing no units, a bare string, or a list
whose length differs from the channel count is a ValueError for every tabular
format, NPY included.
"""

import csv
import math
import uuid
from pathlib import Path

import numpy as np

from .base import Chunk, SourceSpec, StreamDescriptor, StreamPlan, register_source

READERS = {".csv": ",", ".tsv": "\t", ".txt": ",", ".npy": None}
FORMATS = tuple(sorted(READERS))
LAYOUTS = ("samples_channels", "channels_samples")
COMMENT_PREFIXES = ("#", "%")
DEFAULT_MAX_SAMPLES = 10_000_000


def _file(value):
    path = Path(value)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Use a regular local data file")
    if path.suffix.lower() not in READERS:
        raise ValueError("Supported data files: CSV, TSV, NPY, OpenBCI TXT")
    return path


def _labels(value, what):
    if isinstance(value, (str, bytes)) or not hasattr(value, "__len__"):
        raise ValueError(f"Provide a list of {what}, one per channel")
    labels = [value[i] for i in range(len(value))]
    if any(not isinstance(label, str) or not label for label in labels):
        raise ValueError(f"{what} must be nonempty strings")
    return labels


def _bounds(value, what, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{what} must be an explicit number; it is never inferred")
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{what} must be finite and between {low} and {high}")
    return value


def open(
    path,
    *,
    channels,
    units,
    sample_rate_hz,
    start_us,
    layout="samples_channels",
    has_header=None,
    skip_columns=0,
    trailing_columns=0,
    time_column=None,
    delimiter=None,
    chunk_samples=1024,
    max_samples=DEFAULT_MAX_SAMPLES,
    reference="unspecified",
    clock_domain="unix_us",
    modality="eeg",
    channel_types=None,
    stream_id=None,
):
    """Validate every explicit option and return one tabular StreamPlan iterator."""
    file = _file(path)
    names = _labels(channels, "channel names")
    if not 1 <= len(names) <= 512:
        raise ValueError("Provide 1-512 channels")
    if len(set(names)) != len(names):
        raise ValueError("Channel names must be unique")
    if units is None:
        raise ValueError(
            "units are never inferred for tabular data; provide one unit per channel"
        )
    if isinstance(units, (str, bytes)):
        raise ValueError(
            "A single unit string is ambiguous; provide one explicit unit per channel"
        )
    unit_list = _labels(units, "units")
    if len(unit_list) != len(names):
        raise ValueError("Provide exactly one explicit unit per channel")
    rate = _bounds(sample_rate_hz, "sample_rate_hz", 80, 100_000)
    if type(start_us) is not int or not 0 <= start_us < 2**63 - 1:
        raise ValueError("start_us must be a nonnegative i64 microsecond timestamp")
    if layout not in LAYOUTS:
        raise ValueError(f"layout must be one of {', '.join(LAYOUTS)}")
    if has_header not in (None, True, False):
        raise ValueError("has_header must be True, False or None")
    if type(skip_columns) is not int or skip_columns < 0:
        raise ValueError("skip_columns must be a nonnegative integer")
    if type(trailing_columns) is not int or trailing_columns < 0:
        raise ValueError("trailing_columns must be a nonnegative integer")
    retained = len(names) + (1 if time_column is not None else 0)
    if time_column is not None and (
        type(time_column) is not int
        or not skip_columns <= time_column < skip_columns + retained
    ):
        raise ValueError(
            f"time_column must be an absolute row index within the retained columns "
            f"{skip_columns}-{skip_columns + retained - 1}"
        )
    if file.suffix.lower() == ".npy":
        delimiter = None  # NPY is a binary array; no delimiter applies
    else:
        if delimiter is None:
            delimiter = READERS[file.suffix.lower()]
        if not isinstance(delimiter, str) or len(delimiter) != 1:
            raise ValueError("delimiter must be a single character")
    if type(chunk_samples) is not int or not 1 <= chunk_samples <= 1_000_000:
        raise ValueError("chunk_samples must be an integer 1-1000000")
    if type(max_samples) is not int or not 1 <= max_samples <= 10**9:
        raise ValueError("max_samples must be a positive integer")
    if not isinstance(reference, str) or not reference:
        raise ValueError("reference must be a nonempty label")
    types = (
        list(channel_types)
        if channel_types is not None
        else [str(modality).upper()] * len(names)
    )
    if len(types) != len(names):
        raise ValueError("channel_types must match the channel count")
    return _plans(
        file,
        names=names,
        unit_list=unit_list,
        types=types,
        rate=rate,
        start_us=start_us,
        layout=layout,
        has_header=has_header,
        skip_columns=skip_columns,
        trailing_columns=trailing_columns,
        time_column=time_column,
        delimiter=delimiter,
        chunk_samples=chunk_samples,
        max_samples=max_samples,
        reference=reference,
        clock_domain=clock_domain,
        modality=modality,
        stream_id=stream_id or modality,
    )


def _numeric(cell):
    try:
        return math.isfinite(float(cell))
    except ValueError:
        return False


def _rows(path, delimiter, skip_columns, trailing_columns, retained, has_header):
    """Yield (row number, numeric cells) after header, comment and column trimming.

    The first row is skipped only when has_header is True, or when has_header is
    None and that row contains a token that is not a finite number. No unit, rate
    or channel name is ever read from it.
    """
    width = skip_columns + retained + trailing_columns
    with path.open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.reader(handle, delimiter=delimiter, skipinitialspace=True)
        first, number = True, 0
        for raw in reader:
            cells = [cell.strip() for cell in raw]
            if not cells or all(not cell for cell in cells):
                continue
            if cells[0][:1] in COMMENT_PREFIXES:
                continue
            if first:
                first = False
                stop = len(cells) - trailing_columns if trailing_columns else len(cells)
                header = (
                    any(not _numeric(cell) for cell in cells[skip_columns:stop])
                    if has_header is None
                    else has_header
                )
                if header:
                    continue
            number += 1
            if len(cells) != width:
                raise ValueError(
                    f"Row {number} has {len(cells)} columns but {width} were requested "
                    "(skip_columns + one per channel + optional time column + "
                    "trailing_columns); adjust the explicit column options"
                )
            stop = len(cells) - trailing_columns if trailing_columns else len(cells)
            selected = cells[skip_columns:stop]
            values = []
            for cell in selected:
                try:
                    value = float(cell)
                except ValueError:
                    raise ValueError(
                        f"Row {number} is not numeric; pass has_header=True if the "
                        "file starts with a column-name row"
                    ) from None
                if not math.isfinite(value):
                    raise ValueError(f"Row {number} contains a non-finite value")
                values.append(value)
            yield number, values


def _plans(
    file,
    *,
    names,
    unit_list,
    types,
    rate,
    start_us,
    layout,
    has_header,
    skip_columns,
    trailing_columns,
    time_column,
    delimiter,
    chunk_samples,
    max_samples,
    reference,
    clock_domain,
    modality,
    stream_id,
):
    descriptor = StreamDescriptor(
        channels=names,
        units=unit_list,
        channel_types=types,
        sample_rate_hz=float(rate),
        reference=reference,
        clock_domain=clock_domain,
        source_clock=None,
        modality=modality,
        provenance={
            "runtime": "tabular",
            "path": file.name,
            "file_format": file.suffix.lower(),
            "layout": layout,
            "has_header": has_header,
            "skip_columns": skip_columns,
            "trailing_columns": trailing_columns,
            "time_column": time_column,
            "delimiter": delimiter,
            "units_explicit": True,
            "sample_rate_hz_explicit": True,
            "clock_domain": clock_domain,
            "stream_id": stream_id,
        },
    )
    if file.suffix.lower() == ".npy":
        chunks = _npy_chunks(
            file, names, layout, rate, start_us, chunk_samples, max_samples
        )
    else:
        chunks = _text_chunks(
            file,
            names,
            layout,
            rate,
            start_us,
            chunk_samples,
            max_samples,
            skip_columns,
            trailing_columns,
            time_column,
            delimiter,
            has_header,
        )
    yield StreamPlan(descriptor, chunks)


def _npy_chunks(file, names, layout, rate, start_us, chunk_samples, max_samples):
    values = np.load(str(file), allow_pickle=False)
    if values.ndim != 2 or values.dtype.kind not in "fiu":
        raise ValueError("A tabular NPY file must be a 2-D real numeric array")
    if layout == "samples_channels":
        if values.shape[1] != len(names):
            raise ValueError(
                "NPY shape does not match the explicit channel count for "
                "samples_channels layout"
            )
        values = values.T
    elif values.shape[0] != len(names):
        raise ValueError(
            "NPY shape does not match the explicit channel count for "
            "channels_samples layout"
        )
    if values.shape[1] > max_samples:
        raise ValueError("NPY exceeds max_samples; raise the bound explicitly")
    if not np.isfinite(values).all():
        raise ValueError("NPY contains a non-finite value")
    data = values.astype("<f4")
    segment = uuid.uuid4().hex
    for offset in range(0, data.shape[1], chunk_samples):
        stop = min(offset + chunk_samples, data.shape[1])
        yield Chunk(
            values=np.ascontiguousarray(data[:, offset:stop]),
            times=_times(offset, rate, start_us, stop - offset),
            sample_start=offset,
            segment_id=segment,
        )


def _text_chunks(
    file,
    names,
    layout,
    rate,
    start_us,
    chunk_samples,
    max_samples,
    skip_columns,
    trailing_columns,
    time_column,
    delimiter,
    has_header,
):
    retained = len(names) + (1 if time_column is not None else 0)
    rows = _rows(
        file, delimiter, skip_columns, trailing_columns, retained, has_header
    )
    segment = uuid.uuid4().hex
    local_time = None if time_column is None else time_column - skip_columns

    def split(values):
        if local_time is None:
            return values, None
        return [v for i, v in enumerate(values) if i != local_time], values[local_time]

    if layout == "samples_channels":
        block, stamps, index = [], [], 0
        for _number, values in rows:
            values, stamp = split(values)
            if stamp is not None:
                stamps.append(stamp)
            block.append(values)
            if len(block) == chunk_samples:
                yield _samples_chunk(block, stamps, index, rate, start_us, segment)
                index, block, stamps = index + len(block), [], []
        if block:
            yield _samples_chunk(block, stamps, index, rate, start_us, segment)
        elif index == 0:
            raise ValueError("File contains no numeric rows in the requested layout")
        return
    channels, stamps, count = [[] for _ in names], [], 0
    for _number, values in rows:
        values, stamp = split(values)
        if stamp is not None:
            stamps.append(stamp)
        count += 1
        if count > len(names):
            raise ValueError(
                "channels_samples layout needs exactly one row per channel"
            )
        if len(values) > max_samples:
            raise ValueError("File exceeds max_samples; raise the bound explicitly")
        for index in range(len(values)):
            channels[index].append(values[index])
    if count != len(names) or not channels[0]:
        raise ValueError(
            "channels_samples layout needs exactly one numeric row per channel"
        )
    data = np.asarray(channels, dtype="<f4")
    times = _row_times(stamps, data.shape[1], rate, start_us)
    for offset in range(0, data.shape[1], chunk_samples):
        stop = min(offset + chunk_samples, data.shape[1])
        yield Chunk(
            values=np.ascontiguousarray(data[:, offset:stop]),
            times=times[offset:stop],
            sample_start=offset,
            segment_id=segment,
        )


def _samples_chunk(block, stamps, index, rate, start_us, segment):
    values = np.asarray(block, dtype="<f4").T
    times = _row_times(stamps, values.shape[1], rate, start_us, index=index)
    return Chunk(
        values=np.ascontiguousarray(values),
        times=times,
        sample_start=index,
        segment_id=segment,
    )


def _row_times(stamps, count, rate, start_us, index=0):
    times = _times(index, rate, start_us, count)
    if stamps:
        source = np.asarray(stamps, dtype="<f8")
        if len(source) != count:
            raise ValueError("time_column count does not match the sample count")
        if not np.isfinite(source).all() or np.any(np.diff(source) < 0):
            raise ValueError("time_column values must be finite and nondecreasing")
        times = source
    return times


def _times(index, rate, start_us, count):
    return start_us / 1e6 + np.arange(index, index + count) / rate


register_source(
    SourceSpec(
        id="tabular",
        family="table",
        formats=FORMATS,
        description=(
            "CSV/TSV/NPY/OpenBCI TXT/BrainFlow CSV with explicit channels, units, "
            "sample rate, start time and layout; nothing is inferred."
        ),
        detect=lambda path: Path(str(path)).suffix.lower() in READERS,
        open=open,
    )
)
