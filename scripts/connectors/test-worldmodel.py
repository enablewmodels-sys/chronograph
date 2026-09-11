#!/usr/bin/env python3
"""Repeat Gymnasium -> Rust/Arrow -> actual Minari -> Rust exact-state replay twice."""
import importlib.metadata
import json
import pathlib
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
report = root / "bench/reports/v0.3.0/phase-4-worldmodel"
report.mkdir(parents=True, exist_ok=True)
results = {"versions": {n: importlib.metadata.version(n) for n in ("minari", "gymnasium", "numpy", "pyarrow", "h5py")}, "checks": []}
with (report / "minari-roundtrip.log").open("w") as log:
    for repeat in (1, 2):
        with tempfile.TemporaryDirectory(prefix="chronograph-worldmodel-e2e-") as d:
            directory = pathlib.Path(d)
            commands = [
                [sys.executable, str(root / "scripts/connectors/make-worldmodel-fixture.py"), str(directory / "source.json")],
                ["cargo", "run", "--locked", "-p", "chronograph-conn-worldmodel", "--example", "worldmodel_connector", "--", str(directory / "graph"), str(directory / "source.json")],
                [sys.executable, str(root / "scripts/connectors/export-minari.py"), str(directory / "graph/worldmodel.arrow"), str(directory / "minari")],
                ["cargo", "run", "--locked", "-p", "chronograph-conn-worldmodel", "--example", "worldmodel_connector", "--", str(directory / "restored"), str(directory / "minari/roundtrip-steps.json")],
            ]
            for command in commands:
                r = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
                log.write("$ " + " ".join(command) + "\n" + r.stdout + "\n"); log.flush()
                print("\n".join(r.stdout.splitlines()[-10:]), flush=True)
                results["checks"].append({"repeat": repeat, "command": command, "exit_code": r.returncode})
                (report / "minari-roundtrip.json").write_text(json.dumps(results, indent=2) + "\n")
                if r.returncode:
                    raise SystemExit(r.returncode)
            original = json.loads((directory / "source.json").read_text())
            restored = json.loads((directory / "minari/roundtrip-steps.json").read_text())
            if original != restored:
                raise AssertionError("Gymnasium source and Minari-reconstructed source differ")
print("Both Gymnasium → graph/Arrow → actual Minari → Rust complete-state/RNG replay runs passed.")
