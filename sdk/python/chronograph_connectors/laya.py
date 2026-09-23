"""Laya decision records. Model inference stays in the caller's environment."""
from .jev import _decision_record, _json


def laya_decision(response, *, checkpoint=None, checkpoint_revision=None, runtime_version=None, **options):
    """Keep the returned model alias and actual checkpoint separate.

    Router/HTTP responses supply routing.repo; direct Agent results require an
    explicit checkpoint. Pass a verified artifact revision if available; never
    infer it from the generic 'laya-rl-agent' response model. Inputs are opt-in.
    """
    response = _json(response)
    if not isinstance(response, dict):
        raise ValueError("Laya response must be an object")
    routing = response.get("routing", {})
    if not isinstance(routing, dict):
        raise ValueError("Laya routing must be an object")
    checkpoint = checkpoint or routing.get("repo")
    if not isinstance(checkpoint, str) or not 1 <= len(checkpoint.encode()) <= 256:
        raise ValueError("Provide the actual Laya checkpoint or routing.repo")
    metadata = {"checkpoint": checkpoint, "routing": routing}
    for name, value in (("checkpoint_revision", checkpoint_revision), ("runtime_version", runtime_version)):
        if value is not None:
            if not isinstance(value, str) or not 1 <= len(value.encode()) <= 128:
                raise ValueError("Invalid Laya runtime/checkpoint revision")
            metadata[name] = value
    record = _decision_record(response, provider="convai", rounded=True, **options)
    record["fields"].update(metadata)
    return record
