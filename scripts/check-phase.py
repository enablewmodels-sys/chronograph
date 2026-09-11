#!/usr/bin/env python3
"""Run the mandatory Rust phase gate and retain exact command evidence."""
import argparse
import datetime
import json
import pathlib
import platform
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("phase")
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parent.parent
out = root / "bench" / "reports" / "v0.4.0-alpha.2" / args.phase
out.mkdir(parents=True, exist_ok=True)
checks = [
    ("build", ["cargo", "build", "--locked", "--workspace"]),
    ("test", ["cargo", "test", "--locked", "--workspace"]),
    ("clippy", ["cargo", "clippy", "--locked", "--workspace", "--all-targets", "--", "-D", "warnings"]),
    ("fmt", ["cargo", "fmt", "--all", "--", "--check"]),
]
report = {"phase": args.phase, "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "platform": platform.platform(), "checks": []}
for name, cmd in checks:
    print("Running " + " ".join(cmd), flush=True)
    start = datetime.datetime.now(datetime.timezone.utc)
    result = subprocess.run(cmd, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    (out / (name + ".log")).write_text("$ " + " ".join(cmd) + "\n" + result.stdout)
    report["checks"].append({"command": cmd, "exit_code": result.returncode,
                             "seconds": (datetime.datetime.now(datetime.timezone.utc)-start).total_seconds(),
                             "output": name + ".log"})
    (out / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print("\n".join(result.stdout.splitlines()[-10:]), flush=True)
    if result.returncode:
        sys.exit(result.returncode)
print("All required checks passed; exact output retained in " + str(out.relative_to(root)), flush=True)
