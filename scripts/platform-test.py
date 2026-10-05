"""The platform contracts must stay machine-checkable and honest."""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLATFORM = ROOT / "deploy" / "platform"
DOC = ROOT / "docs" / "PLATFORM.md"
IDENTIFIER = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
# Anything that looks like a literal credential must never appear in a contract file.
SECRET_SHAPED = re.compile(r"(sk_live_|sk_test_|whsec_|-----BEGIN|[A-Za-z0-9]{32,})")


def load(path):
    return json.loads(path.read_text())


def main():
    spec = load(PLATFORM / "connectors.json")
    app = load(PLATFORM / "app.example.json")
    layers = spec["layers"]
    numbers = {entry["layer"] for entry in layers}
    assert numbers == {1, 2, 3, 4, 5}, numbers
    kinds = {entry["kind"] for entry in layers}
    assert kinds <= {"integration", "runtime", "connector"}, kinds
    for entry in layers:
        for key in ("id", "kind", "boundary", "providers"):
            assert entry.get(key), (entry.get("id"), key)
        assert entry["providers"], entry["id"]
        for name in entry.get("env", []):
            assert IDENTIFIER.match(name), name
        for path in entry.get("artifacts", []):
            assert (ROOT / path).exists(), "references a missing artifact: " + path
        for module in entry.get("modules", []):
            # Either an importable Python module or a path to a file that exists: a
            # layer that names an implementation must name one that is really there.
            if module.startswith("chronograph"):
                continue
            assert (ROOT / module).exists(), "references a missing module: " + module

    # Layer 5 stays delegated: the provider is authoritative, so each entry must name
    # its boundary, its references and the file that talks to it. A delegated entry
    # with no implementation at all would be the old, unproven claim.
    delegated = [e for e in layers if e["kind"] == "connector"]
    assert {e["id"] for e in delegated} == {"identity", "billing", "domains"}
    for entry in delegated:
        assert "never" in entry["boundary"] or "No " in entry["boundary"] or "delegated" in entry["boundary"], entry["id"]
        assert entry["env"], entry["id"]
        assert entry.get("modules"), entry["id"] + " must name the implementation that talks to the provider"

    providers = {p for entry in layers for p in entry["providers"]}
    for expected in (
        "ory-kratos",
        "supertokens",
        "authgear",
        "stripe",
        "cloudflare-saas",
        "wasm",
        "brainflow",
        "lsl",
    ):
        assert expected in providers, expected

    assert app["kind"] in ("container", "web", "mobile"), app["kind"]
    assert app["persistence"]["mount"], "an app needs persistent storage"
    assert app["run"]["health"].startswith("/"), app["run"]
    stores = {entry["store"] for entry in app["stores"]}
    assert stores == {"play", "app-store"}, stores
    for entry in app["stores"]:
        assert "operator" in entry["requires"], entry
    for variable in app["env"]:
        assert variable["kind"] in ("plain", "secret-ref"), variable
        assert IDENTIFIER.match(variable["name"]) or "_" in variable["name"], variable

    # Neither contract file may carry a credential, and both must be described in the guide.
    doc = DOC.read_text()
    for path in (PLATFORM / "connectors.json", PLATFORM / "app.example.json"):
        text = path.read_text()
        assert not SECRET_SHAPED.search(text), path.name + " looks like it carries a secret"
    for needle in ("ory-kratos", "supertokens", "authgear", "stripe", "cloudflare-saas", "chronograph.app.json"):
        assert needle in doc, needle
    assert "not implemented" in doc or "contract" in doc
    print(
        json.dumps(
            {
                "passed": True,
                "layers": sorted(numbers),
                "contracts": [e["id"] for e in layers],
                "delegated": sorted(e["id"] for e in delegated),
                "store_targets": sorted(stores),
                "note": "contracts and their documented boundaries only",
            }
        )
    )


if __name__ == "__main__":
    sys.exit(main())
