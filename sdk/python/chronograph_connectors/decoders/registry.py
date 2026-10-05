"""Decoder registry: built-ins, third-party factories, entry-point discovery.

A third party plugs a model in without editing this repository by publishing a
package that exposes a zero-argument factory under the entry-point group
"chronograph.decoders":

    [project.entry-points."chronograph.decoders"]
    my-model = "my_package.decoders:factory"

Discovery is lazy. Importing this module imports no decoder implementation and
no heavy numeric stack; the built-in factories import their module only when a
decoder is actually instantiated. A broken entry point is never fatal: the
error is collected and reported by describe_all() as an unavailable record.
"""

from __future__ import annotations

import importlib.metadata

from .base import AdapterError

ENTRY_POINT_GROUP = "chronograph.decoders"
_ERROR_LIMIT = 512

_FACTORIES: dict = {}
_SOURCES: dict = {}
_ENTRY_POINTS: dict | None = None
_ENTRY_POINT_ERROR: str | None = None
_SHADOWED: list = []


def _csp_lda_factory():
    from .csp_lda import CSPLDAAdapter

    return CSPLDAAdapter()


def _eeg2text_factory():
    from .eeg2text import EEG2TextDecoder

    return EEG2TextDecoder()


_FACTORIES["csp-lda-v1"] = _csp_lda_factory
_FACTORIES["eeg2text-v1"] = _eeg2text_factory
_SOURCES["csp-lda-v1"] = "builtin"
_SOURCES["eeg2text-v1"] = "builtin"


def _message(error) -> str:
    text = f"{type(error).__name__}: {error}"
    return text[:_ERROR_LIMIT]


def _discover(force: bool = False) -> dict:
    """Collect entry points by name without loading any of them."""
    global _ENTRY_POINTS, _ENTRY_POINT_ERROR, _SHADOWED
    if _ENTRY_POINTS is not None and not force:
        return _ENTRY_POINTS
    _ENTRY_POINT_ERROR = None
    _SHADOWED = []
    try:
        selected = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    except TypeError:
        try:
            selected = importlib.metadata.entry_points().get(ENTRY_POINT_GROUP, [])
        except Exception as error:  # noqa: BLE001 - discovery must never be fatal
            _ENTRY_POINT_ERROR = f"entry point discovery failed: {_message(error)}"
            selected = []
    except Exception as error:  # noqa: BLE001 - discovery must never be fatal
        _ENTRY_POINT_ERROR = f"entry point discovery failed: {_message(error)}"
        selected = []
    found: dict = {}
    for entry in selected:
        name = getattr(entry, "name", None)
        if not isinstance(name, str) or not name or len(name) > 128:
            continue
        if name in _FACTORIES:
            _SHADOWED.append(name)
            continue
        found[name] = entry
    _ENTRY_POINTS = found
    return found


def refresh():
    """Re-run entry-point discovery, for example after installing a plugin."""
    _discover(force=True)
    return decoders()


def register_decoder(factory=None, *, name=None, replace=False):
    """Register a decoder factory; usable as a plain call or as a decorator.

    The factory is a zero-argument callable (a function or a class) returning a
    DecoderAdapter. Without an explicit name the factory's decoder_name
    attribute, or its __name__, is used:

        register_decoder(MyAdapter, name="my-model")
        register_decoder(name="my-model")(MyAdapter)
    """
    def _register(target):
        key = name or getattr(target, "decoder_name", None) or getattr(target, "__name__", None)
        if not isinstance(key, str) or not key or len(key) > 128:
            raise AdapterError(
                "a registered decoder needs a nonempty name of at most 128 characters"
            )
        if not callable(target):
            raise AdapterError(f"decoder factory {key} must be callable")
        if key in _FACTORIES and _SOURCES.get(key) == "builtin" and not replace:
            raise AdapterError(
                f"{key} is a built-in decoder name; pass replace=True to shadow it deliberately"
            )
        _FACTORIES[key] = target
        _SOURCES[key] = "registered"
        return target

    if factory is None:
        return _register
    return _register(factory)


def unregister_decoder(name):
    """Remove a registered factory; returns True when one was removed."""
    if _SOURCES.get(name) == "builtin":
        raise AdapterError(f"{name} is a built-in decoder and cannot be unregistered")
    return _FACTORIES.pop(name, None) is not None


def decoders():
    """Sorted names of every known decoder, loading none of them."""
    return sorted(set(_FACTORIES) | set(_discover()))


def _factory_for(name):
    if name in _FACTORIES:
        return _FACTORIES[name], _SOURCES.get(name, "registered")
    entry = _discover().get(name)
    if entry is None:
        available = ", ".join(decoders()) or "none"
        raise AdapterError(f"unknown decoder {name!r}; available decoders: {available}")
    try:
        factory = entry.load()
    except Exception as error:  # noqa: BLE001 - surfaced as an actionable AdapterError
        raise AdapterError(
            f"entry point {name!r} ({getattr(entry, 'value', '?')}) failed to load: "
            f"{_message(error)}"
        ) from None
    if not callable(factory):
        raise AdapterError(
            f"entry point {name!r} resolved to {type(factory).__name__}, not a callable "
            "decoder factory"
        )
    return factory, "entry-point"


def decoder(name):
    """Instantiate a decoder by name; the implementation imports only here."""
    if not isinstance(name, str) or not name or len(name) > 128:
        raise AdapterError("decoder name must be a nonempty string of at most 128 characters")
    factory, _source = _factory_for(name)
    try:
        instance = factory()
    except AdapterError:
        raise
    except Exception as error:  # noqa: BLE001 - surfaced as an actionable AdapterError
        raise AdapterError(f"decoder factory {name!r} failed: {_message(error)}") from None
    if not callable(getattr(instance, "manifest", None)) or not callable(
        getattr(instance, "predict", None)
    ):
        raise AdapterError(
            f"decoder {name!r} does not implement the adapter contract "
            "(manifest() and predict(epochs))"
        )
    return instance


def describe_all():
    """Manifest record for every known decoder, including unavailable ones.

    Each record carries the manifest fields plus name, source and available. A
    record with available False carries an error string instead of a manifest;
    this function never raises for a broken plugin or a broken entry point.
    """
    _discover()
    records = []
    for name in decoders():
        source = _SOURCES.get(name, "entry-point")
        record = {"name": name, "source": source, "available": True}
        try:
            record.update(decoder(name).manifest().to_dict())
            record["name"] = name
            record["source"] = source
            record["available"] = True
        except Exception as error:  # noqa: BLE001 - reported, never raised here
            record["available"] = False
            record["error"] = _message(error)
        if name in _SHADOWED:
            record["notes"] = [
                f"an installed entry point named {name!r} was ignored because a "
                "registered decoder already provides that name"
            ]
        records.append(record)
    if _ENTRY_POINT_ERROR:
        records.append(
            {
                "name": ENTRY_POINT_GROUP,
                "source": "entry-point",
                "available": False,
                "error": _ENTRY_POINT_ERROR,
            }
        )
    return records
