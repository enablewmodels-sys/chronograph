#!/usr/bin/env python3
"""Repeat real compressed MCAP -> Rust graph -> Arrow -> LeRobot writer/reader, in isolated directories."""
import importlib.metadata
import json
import pathlib
import subprocess
import sys
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
report = root / "bench/reports/v0.3.0/phase-4-robotics"
report.mkdir(parents=True, exist_ok=True)
results = {"versions": {name: importlib.metadata.version(name) for name in ("lerobot", "numpy", "pyarrow", "torch", "rosbags", "mcap")}, "checks": []}
with (report / "lerobot-roundtrip.log").open("w") as log:
    for repeat in (1, 2):
        with tempfile.TemporaryDirectory(prefix="chronograph-robotics-e2e-") as d:
            work = pathlib.Path(d) / "graph"
            commands = [
                ["cargo", "run", "--locked", "-p", "chronograph-conn-robotics", "--example", "robotics_connector", "--", str(work), str(root / "examples/datasets/robotics/references.mcap")],
                [sys.executable, str(root / "scripts/connectors/export-lerobot.py"), str(work / "lerobot.arrow"), str(work / "lerobot"), "--dtype", "float64"],
                [sys.executable, str(root / "scripts/connectors/export-lerobot.py"), str(work / "lerobot.arrow"), str(work / "lerobot-f32"), "--dtype", "float32"],
            ]
            for command in commands:
                r = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120)
                log.write("$ " + " ".join(command) + "\n" + r.stdout + "\n"); log.flush()
                print("\n".join(r.stdout.splitlines()[-15:]), flush=True)
                results["checks"].append({"repeat": repeat, "command": command, "exit_code": r.returncode})
                (report / "lerobot-roundtrip.json").write_text(json.dumps(results, indent=2) + "\n")
                if r.returncode:
                    raise SystemExit(r.returncode)
print("Both MCAP → graph → Arrow → actual LeRobot dataset/temporal-reader runs passed.")
