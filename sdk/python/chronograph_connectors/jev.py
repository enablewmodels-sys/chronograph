"""TypeSafe Jev decision binding. No inference or credentials enter the database.

Contract: https://docs.typesafe.ai/api (reviewed 2026-09-20).
The caller runs TypeSafe's SDK and passes a response or JSON dictionary here.
"""
import hashlib
import json
import math


def _prob(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


def _json(value):
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json")
    return json.loads(json.dumps(value, allow_nan=False, ensure_ascii=False))


def validate_answers(answers):
    if not isinstance(answers, dict) or not 1 <= len(answers) <= 64:
        raise ValueError("Jev requires 1–64 named answers")
    for name, answer in answers.items():
        if not isinstance(name, str) or not 1 <= len(name.encode()) <= 128 or not isinstance(answer, dict):
            raise ValueError("Invalid Jev answer")
        kind = answer.get("type")
        if kind == "noul":
            if not _prob(answer.get("noul")):
                raise ValueError("Noul must be a probability in [0,1]")
            continue
        if kind not in ("choice", "score"):
            raise ValueError("Unsupported Jev answer type")
        probs = answer.get("probabilities")
        if (not isinstance(probs, dict) or not 1 <= len(probs) <= 255
                or any(not isinstance(k, str) or not 1 <= len(k.encode()) <= 256 or not _prob(p) for k, p in probs.items())
                or abs(sum(probs.values()) - 1) > 0.001 or not _prob(answer.get("confidence"))):
            raise ValueError("Jev probabilities must sum to one and confidence must be in [0,1]")
        if kind == "choice":
            if not isinstance(answer.get("choice"), str) or answer["choice"] not in probs:
                raise ValueError("Choice must be one of the probability keys")
        else:
            legend, score = answer.get("legend"), answer.get("score")
            if (not isinstance(legend, dict) or set(legend) != set(probs) or not 2 <= len(legend) <= 10
                    or any(not k.isascii() or not k.isdecimal() or int(k) > 2**32 - 1 or not isinstance(v, (str, dict, list)) for k, v in legend.items())
                    or type(score) not in (int, float) or not math.isfinite(score)
                    or not min(map(int, legend)) <= score <= max(map(int, legend))):
                raise ValueError("Score requires matching numeric legend and a value within its range")


def jev_decision(response, *, request, src, dst, timestamp_us, mode, client=None, attach_inputs=False, episode=None):
    """Normalize an official SDK response; optional request/response assets are explicit.

    mode is mandatory: 'live' for an actual provider response, 'fixture' for samples.
    SHA-256 covers compact UTF-8 JSON with the request's insertion order preserved.
    Raw state and questions are not retained unless attach_inputs=True. This
    fingerprint is provenance, not anonymization of low-entropy input.
    """
    request, response = _json(request), _json(response)
    if not isinstance(request, dict) or not isinstance(response, dict):
        raise ValueError("Request and response must be JSON objects")
    model, requested = response.get("model"), request.get("model")
    if any(not isinstance(v, str) or not 1 <= len(v.encode()) <= 128 for v in (model, requested)):
        raise ValueError("Requested and returned model identifiers are required")
    if mode not in ("live", "fixture"):
        raise ValueError("Set mode explicitly to live or fixture")
    questions, answers = request.get("questions"), response.get("answers")
    validate_answers(answers)
    if (not isinstance(questions, dict) or set(questions) != set(answers)
            or any(not isinstance(questions[k], dict) or questions[k].get("type") != a["type"] for k, a in answers.items())
            or "state" not in request):
        raise ValueError("Every answer must match a supplied question and type")
    data = json.dumps(request, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    if len(data) > 1024 * 1024:
        raise ValueError("Example request exceeds 1 MiB; preprocess or split your state")
    assets = {}
    if attach_inputs:
        if client is None:
            raise ValueError("A Chronograph client is required for attachment uploads")
        for name, raw in (("request", data), ("response", json.dumps(response, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode())):
            assets[name] = client.asset(raw, kind="opaque", encoding="json", provenance={"provider": "typesafe", "mode": mode})
    for value, lo, hi in ((src, 0, 2**64 - 1), (dst, 0, 2**64 - 1), (timestamp_us, -2**63, 2**63 - 2)):
        if isinstance(value, bool) or not isinstance(value, (int, str)) or not lo <= int(value) <= hi:
            raise ValueError("Use exact integer IDs and microsecond timestamps")
    return {"src": str(src), "dst": str(dst), "timestamp_us": str(timestamp_us), "episode": episode,
            "assets": assets, "fields": {"provider": "typesafe", "model": model, "requested_model": requested,
            "input_sha256": hashlib.sha256(data).hexdigest(), "answers": answers, "mode": mode,
            "usage": response.get("usage", {})}}
