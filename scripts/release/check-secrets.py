#!/usr/bin/env python3
"""Refuse a credential-shaped string anywhere it could be published.

release/package.py already refuses one inside a source archive, but that runs once, at
packaging time, on a tree somebody remembered to check. This runs on the tree itself, in CI, on
every push, and again over the evidence a failed run uploads: the token format the engine mints
is a fixed shape (`cg_<16 hex>_<64 hex>`), so a leak of the real thing is recognisable without
reading anything private.

Usage:
    python3 scripts/release/check-secrets.py [path ...]

With no path it scans every tracked file. With paths it scans those files and directories as
well, which is how the CI evidence folder is checked before it is uploaded.
"""
import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from patterns import SECRET  # noqa: E402  (the same shapes release/package.py refuses)

root = pathlib.Path(__file__).resolve().parent.parent.parent


def tracked():
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True
    )
    for name in result.stdout.decode().split("\0"):
        if name:
            yield root / name


def extra(arguments):
    for argument in arguments:
        path = pathlib.Path(argument)
        if not path.is_absolute():
            path = root / path
        if path.is_dir():
            yield from sorted(p for p in path.rglob("*") if p.is_file())
        elif path.is_file():
            yield path


def offending(paths):
    found = []
    for path in paths:
        if not path.is_file():
            continue
        try:
            content = path.read_bytes()
        except OSError as error:
            found.append(str(path) + " (unreadable: " + error.strerror + ")")
            continue
        match = SECRET.search(content)
        if match:
            try:
                named = str(path.relative_to(root))
            except ValueError:
                # A path outside the tree, such as the evidence folder CI uploads.
                named = str(path)
            found.append(named + " (" + match.group(0)[:8].decode(errors="replace") + "…)")
    return found


paths = list(tracked()) + list(extra(sys.argv[1:]))
found = offending(paths)
if found:
    print(json.dumps({"status": "FAIL", "credential_shaped": found}, indent=2))
    print("Refusing a credential-shaped string. Remove it, or rotate the credential it names.", file=sys.stderr)
    sys.exit(1)
print(json.dumps({"status": "PASS", "files_scanned": len(paths),
                  "checks": ["token and private-key shapes", "tracked tree",
                             "any path passed on the command line"]}, indent=2))
