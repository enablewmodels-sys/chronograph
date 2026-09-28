"""Operator CPU worker and offline container recipe. Never runs on the DB host."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import uuid
import time
import urllib.request
from . import Client
from .bci import BCIClient
from .bci_spool import encode
from .bci_training import train


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Worker broker redirects are not allowed")


class DirectoryClient:
    def __init__(self, root):
        self.root = Path(root)
        self.manifest = json.loads((self.root / "manifest.json").read_bytes())

    def call(self, op, args):
        if op == "bci_manifest":
            return {"manifest": self.manifest}
        sid = str(args.get("session", ""))
        if sid not in self.manifest["sessions"]:
            raise ValueError("Session not in materialized dataset")
        if op == "bci_session":
            return json.loads((self.root / f"{sid}.session.json").read_bytes())
        if op == "bci_records":
            rows = json.loads((self.root / f"{sid}.records.json").read_bytes())
            if "after" in args:
                rows = [r for r in rows if int(r["edge"]) > int(args["after"])]
            limit = min(args.get("limit", 500), 500)
            selected = rows[:limit]
            return {
                "records": selected,
                "has_more": len(rows) > limit,
                "cursor": selected[-1]["edge"] if selected else args.get("after"),
            }
        raise ValueError("Unsupported offline recipe operation")

    def read_asset(self, asset):
        if not re.fullmatch("[a-f0-9]{32}", asset):
            raise ValueError("Invalid asset ID")
        return json.loads((self.root / f"{asset}.json").read_bytes()), (
            self.root / f"{asset}.bin"
        ).read_bytes()


class Broker:
    def __init__(self, url, token):
        parsed = urllib.parse.urlparse(url)
        if (
            (
                parsed.scheme != "https"
                and not (
                    parsed.scheme == "http"
                    and parsed.hostname in ("127.0.0.1", "localhost")
                )
            )
            or parsed.path not in ("", "/")
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Worker requires HTTPS origin")
        self.url = url.rstrip("/") + "/worker/bci"
        self.token = token
        self.job = None

    def request(self, operation, **payload):
        body = {"operation": operation, **payload}
        if self.job:
            body.update(id=self.job["job"]["id"], lease=self.job["lease"])
        req = urllib.request.Request(
            self.url,
            encode(body),
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.build_opener(_NoRedirect()).open(req, timeout=35) as r:
            data = r.read(4 * 1024 * 1024 + 1)
            if len(data) > 4 * 1024 * 1024:
                raise ValueError("Worker response limit exceeded")
            return json.loads(data)

    def call(self, op, args):
        return self.request(op, arguments=args)

    read_asset = Client.read_asset


def materialize(broker, dest):
    manifest = broker.request("manifest")["manifest"]
    (dest / "manifest.json").write_bytes(encode(manifest))
    size = 0
    seen = set()
    for sid in manifest["sessions"]:
        if not re.fullmatch(r"\d{1,20}", sid):
            raise ValueError("Invalid recording ID")
        detail = broker.call("bci_session", {"session": sid})
        (dest / f"{sid}.session.json").write_bytes(encode(detail))
        rows = list(BCIClient(broker, manifest["instance"]).records(sid))
        (dest / f"{sid}.records.json").write_bytes(encode(rows))
        for row in rows:
            for asset in row["record"]["assets"].values():
                if asset in seen:
                    continue
                seen.add(asset)
                meta, data = broker.read_asset(asset)
                size += len(data)
                if size > 128 * 1024 * 1024:
                    raise ValueError("Dataset exceeds CPU worker input budget")
                (dest / f"{asset}.json").write_bytes(encode(meta))
                (dest / f"{asset}.bin").write_bytes(data)
    return manifest


def container_command(image, source, destination, components, *, name=None):
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError(
            "Use the immutable local image ID returned by docker build --iidfile"
        )
    return [
        "docker",
        "run",
        "--rm",
        *(["--name", name] if name else []),
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--cpus",
        "1",
        "--memory",
        "768m",
        "--memory-swap",
        "768m",
        "--user",
        "65532:65532",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "-e",
        "OPENBLAS_NUM_THREADS=1",
        "-e",
        "OMP_NUM_THREADS=1",
        "-e",
        "PYTHONDONTWRITEBYTECODE=1",
        "-e",
        "MPLCONFIGDIR=/tmp/mpl",
        "-v",
        f"{source}:/input:ro",
        "-v",
        f"{destination}:/output:rw",
        image,
        "python",
        "-m",
        "chronograph_connectors.bci_worker",
        "recipe",
        "--components",
        str(components),
    ]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("mode", choices=["run", "recipe"])
    p.add_argument("--url")
    p.add_argument("--token-file")
    p.add_argument("--image")
    p.add_argument("--once", action="store_true")
    p.add_argument("--components", type=int, default=4)
    a = p.parse_args()
    if a.mode == "recipe":
        import signal

        signal.alarm(900)  # Enforce the deadline even if the operator process dies.
        client = DirectoryClient("/input")
        manifest = client.manifest
        train(
            BCIClient(client, manifest["instance"]),
            manifest,
            "/output/run",
            components=a.components,
        )
        return
    if not all([a.url, a.token_file, a.image]):
        p.error("run requires --url, --token-file and immutable --image")
    tokenfile = Path(a.token_file)
    if tokenfile.is_symlink() or tokenfile.stat().st_mode & 0o077:
        raise ValueError("Worker credential file must be private mode 0600")
    broker = Broker(a.url, tokenfile.read_text().strip())
    while True:
        broker.job = broker.request("claim")
        if not broker.job:
            if a.once:
                return
            time.sleep(5)
            continue
        stop = threading.Event()
        lost = []

        def heartbeat():
            while not stop.wait(15):
                try:
                    broker.request("heartbeat")
                except Exception:
                    lost.append(True)
                    return

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        process = None
        container_name = "chronodb-bci-" + uuid.uuid4().hex

        def stop_container():
            subprocess.run(
                ["docker", "rm", "-f", container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
            if process and process.poll() is None:
                process.kill()
                process.wait()

        try:
            with tempfile.TemporaryDirectory(prefix="chronodb-bci-job-") as root:
                source = Path(root) / "input"
                dest = Path(root) / "output"
                source.mkdir(mode=0o755)
                dest.mkdir(mode=0o777)
                dest.chmod(0o777)
                materialize(broker, source)
                for f in source.iterdir():
                    f.chmod(0o444)
                cmd = container_command(
                    a.image,
                    source,
                    dest,
                    broker.job["job"]["specification"]["components"],
                    name=container_name,
                )
                process = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                until = time.monotonic() + 900
                while process.poll() is None:
                    if lost or time.monotonic() > until:
                        stop_container()
                        raise RuntimeError("Lease expired or CPU job exceeded runtime")
                    time.sleep(0.5)
                if process.returncode:
                    raise RuntimeError("CPU recipe failed; no output published")
                files = {}
                for name in ("model.json", "weights.npz", "result.json"):
                    path = dest / "run" / name
                    if (
                        path.is_symlink()
                        or not path.is_file()
                        or path.stat().st_size > 128 * 1024
                    ):
                        raise ValueError("Invalid recipe output")
                    files[name] = path.read_bytes()
                result = {
                    "status": "succeeded",
                    "summary": "CSP + LDA CPU recipe completed",
                    "metrics": json.loads(files["result.json"]),
                    "artifact": {
                        "model": json.loads(files["model.json"]),
                        "weights_base64": base64.b64encode(
                            files["weights.npz"]
                        ).decode(),
                        "image": a.image,
                    },
                }
                broker.request("finish", result=result)
        except Exception:
            if not lost:
                try:
                    broker.request(
                        "finish",
                        result={
                            "status": "failed",
                            "summary": "Worker could not complete the bounded recipe. Inspect the worker locally.",
                        },
                    )
                except Exception:
                    pass
        finally:
            if process:
                try:
                    stop_container()
                except (OSError, subprocess.TimeoutExpired):
                    pass
            stop.set()
            thread.join(timeout=36)
            broker.job = None
        if a.once:
            return


if __name__ == "__main__":
    main()
