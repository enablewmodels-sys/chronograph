"""Deterministic band-power features shared by every decoder path.

The numeric recipe here is fixed on purpose: the Rust executor of the
decoder-v1 artifact must reproduce these exact bits.

For a window x (channels x samples) and band center f:

    w[i] = 0.5 - 0.5 * cos(2*pi*i/(N-1))            # w[0] = 1.0 when N == 1
    re[c,k] = sum_i float64(x[c,i]) * w[i] * cos(2*pi*f[k]*i/sample_rate_hz)
    im[c,k] = sum_i float64(x[c,i]) * w[i] * sin(2*pi*f[k]*i/sample_rate_hz)
    p[c,k]  = re[c,k]*re[c,k] + im[c,k]*im[c,k]
    feature[c*K + k] = log1p(p[c,k])                 # or p[c,k] when log_features is False

Accumulation order is fixed: the outer loops are window, channel, band and the
innermost loop walks i upward, adding one float64 term at a time. The
implementation below keeps that order exactly (it vectorises only across
independent (window, channel, band) accumulators, never across i), so both
sides can agree bit-for-bit. The cos/sin tables are built with the platform
libm through Python's math module; a Rust implementation that uses
f64::cos/f64::sin from the same libm reproduces them to the last ULP.
"""

from __future__ import annotations

import math
import operator

import numpy as np

from .base import AdapterError

MAX_ELEMENTS = 1 << 25
MAX_WINDOWS = 1 << 20
MAX_BANDS = 64
_FLOAT_KINDS = ("f",)


def _positive_int(value, what, *, maximum):
    if isinstance(value, bool):
        raise AdapterError(f"{what} must be a positive integer")
    try:
        number = operator.index(value)
    except TypeError:
        raise AdapterError(f"{what} must be a positive integer") from None
    if number < 1:
        raise AdapterError(f"{what} must be a positive integer")
    if number > maximum:
        raise AdapterError(f"{what} exceeds the supported maximum of {maximum}")
    return number


def _as_float_windows(windows, what="windows"):
    array = np.asarray(windows)
    if array.dtype.kind not in _FLOAT_KINDS or array.dtype.itemsize not in (4, 8):
        raise AdapterError(
            f"{what} must be a float32 or float64 array, received {array.dtype}"
        )
    if array.ndim != 3:
        raise AdapterError(
            f"{what} must have shape (windows, channels, samples), received {array.shape}"
        )
    count, channels, samples = array.shape
    if channels < 1 or samples < 1:
        raise AdapterError(f"{what} needs at least one channel and one sample per window")
    if count > MAX_WINDOWS or count * channels * samples > MAX_ELEMENTS:
        raise AdapterError(
            f"{what} exceeds the bounded budget of {MAX_ELEMENTS} samples per call"
        )
    values = np.ascontiguousarray(array, dtype=np.float64)
    if not np.isfinite(values).all():
        raise AdapterError(f"{what} contains nonfinite samples")
    return values


def band_list(bands_hz, sample_rate_hz):
    """Validate band CENTER frequencies and return them as a tuple of floats."""
    if isinstance(bands_hz, (str, bytes)) or not hasattr(bands_hz, "__len__"):
        raise AdapterError("bands_hz must be a sequence of band center frequencies")
    bands = tuple(bands_hz)
    if not 1 <= len(bands) <= MAX_BANDS:
        raise AdapterError(f"bands_hz accepts 1..{MAX_BANDS} centers, received {len(bands)}")
    if isinstance(sample_rate_hz, bool) or not isinstance(sample_rate_hz, (int, float)):
        raise AdapterError("sample_rate_hz must be a number")
    rate = float(sample_rate_hz)
    if not math.isfinite(rate) or rate <= 0:
        raise AdapterError("sample_rate_hz must be a finite positive number")
    out = []
    for band in bands:
        if isinstance(band, bool) or not isinstance(band, (int, float)):
            raise AdapterError("band centers must be numbers")
        value = float(band)
        if not math.isfinite(value) or value <= 0 or value >= rate / 2:
            raise AdapterError(
                f"band center {value!r} Hz must be finite, positive and below the "
                f"Nyquist frequency {rate / 2:g} Hz for a {rate:g} Hz stream"
            )
        out.append(value)
    return tuple(out)


def feature_dim(channel_count, bands_hz) -> int:
    """Number of features produced per window: channels * band centers."""
    channels = _positive_int(channel_count, "channel_count", maximum=1 << 16)
    if isinstance(bands_hz, (str, bytes)) or not hasattr(bands_hz, "__len__"):
        raise AdapterError("bands_hz must be a sequence of band center frequencies")
    count = len(tuple(bands_hz))
    if not 1 <= count <= MAX_BANDS:
        raise AdapterError(f"bands_hz accepts 1..{MAX_BANDS} centers, received {count}")
    return channels * count


def hann_window(samples: int) -> np.ndarray:
    """Symmetric Hann window as float64.

    w[i] = 0.5 - 0.5 * cos(2*pi*i/(samples-1)) for i in 0..samples-1, and
    w[0] = 1.0 when samples == 1. Values are computed with Python floats
    (IEEE-754 binary64) in this exact association order.
    """
    samples = _positive_int(samples, "window length", maximum=MAX_ELEMENTS)
    if samples == 1:
        return np.ones(1, dtype=np.float64)
    two_pi = 2.0 * math.pi
    span = samples - 1
    out = np.empty(samples, dtype=np.float64)
    for i in range(samples):
        out[i] = 0.5 - 0.5 * math.cos(two_pi * i / span)
    return out


def _band_tables(bands, rate, samples):
    """cos/sin tables, float64, computed with the same expression as the recipe."""
    two_pi = 2.0 * math.pi
    count = len(bands)
    cos_table = np.empty((count, samples), dtype=np.float64)
    sin_table = np.empty((count, samples), dtype=np.float64)
    for k, band in enumerate(bands):
        for i in range(samples):
            angle = two_pi * band * i / rate
            cos_table[k, i] = math.cos(angle)
            sin_table[k, i] = math.sin(angle)
    return cos_table, sin_table


def band_features(windows, bands_hz, sample_rate_hz, log_features=True):
    """Return float64 band features shaped (windows, channels * len(bands_hz)).

    Feature index c * len(bands_hz) + k, where c is the channel and k the band.
    See the module docstring for the exact accumulation order.
    """
    if not isinstance(log_features, bool):
        raise AdapterError("log_features must be a bool")
    values = _as_float_windows(windows)
    bands = band_list(bands_hz, sample_rate_hz)
    rate = float(sample_rate_hz)
    count, channels, samples = values.shape
    weights = hann_window(samples)
    cos_table, sin_table = _band_tables(bands, rate, samples)
    bands_count = len(bands)
    real = np.zeros((count, channels, bands_count), dtype=np.float64)
    imag = np.zeros((count, channels, bands_count), dtype=np.float64)
    for i in range(samples):
        scaled = values[:, :, i] * weights[i]
        for k in range(bands_count):
            real[:, :, k] += scaled * cos_table[k, i]
            imag[:, :, k] += scaled * sin_table[k, i]
    power = real * real + imag * imag
    features = np.log1p(power) if log_features else power
    return np.ascontiguousarray(features.reshape(count, channels * bands_count))


def window_signal(signal, window_samples, hop_samples):
    """Slice (channels, samples) into consecutive fixed-length windows.

    Rule, stated explicitly: the first window starts at sample 0 and every next
    window starts exactly hop_samples later; a window is emitted only when it is
    fully inside the signal (start + window_samples <= samples). A trailing
    partial window is dropped. Nothing is ever padded, interpolated or
    resampled, and a signal shorter than one window yields an empty list.

    Returns a list of views into the input array (call .copy() before mutating).
    """
    array = np.asarray(signal)
    if array.dtype.kind not in _FLOAT_KINDS or array.dtype.itemsize not in (4, 8):
        raise AdapterError(
            f"signal must be a float32 or float64 array, received {array.dtype}"
        )
    if array.ndim != 2:
        raise AdapterError(
            f"signal must have shape (channels, samples), received {array.shape}"
        )
    channels, samples = array.shape
    if channels < 1 or samples < 1:
        raise AdapterError("signal needs at least one channel and one sample")
    if channels * samples > MAX_ELEMENTS:
        raise AdapterError(f"signal exceeds the bounded budget of {MAX_ELEMENTS} samples")
    length = _positive_int(window_samples, "window_samples", maximum=MAX_ELEMENTS)
    hop = _positive_int(hop_samples, "hop_samples", maximum=MAX_ELEMENTS)
    if length > samples:
        return []
    starts = range(0, samples - length + 1, hop)
    count = (samples - length) // hop + 1
    if count > MAX_WINDOWS:
        raise AdapterError(
            f"windowing would emit {count} windows, above the bound of {MAX_WINDOWS}"
        )
    return [array[:, start : start + length] for start in starts]
