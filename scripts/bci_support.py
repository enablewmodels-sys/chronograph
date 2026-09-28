"""Disposable native service for BCI protocol tests; never targets production."""

from pathlib import Path
import os
import subprocess
import tempfile
import time
import urllib.request
from chronograph_connectors import Client

ROOT = Path(__file__).resolve().parents[1]


class Service:
    def __init__(self, port=18096):
        self.temp = tempfile.TemporaryDirectory(prefix="chronodb-bci-test-")
        self.root = Path(self.temp.name)
        self.url = f"http://127.0.0.1:{port}"
        self.binary = os.environ.get(
            "CHRONOGRAPH_TEST_BINARY", str(ROOT / "target/debug/chronograph-server")
        )
        self.env = {
            **os.environ,
            "CHRONOGRAPH_AUTH": str(self.root / "config/auth.json"),
            "CHRONOGRAPH_DATA": str(self.root / "data"),
            "CHRONOGRAPH_BIND": f"127.0.0.1:{port}",
            "CHRONOGRAPH_ORIGIN": self.url,
            "CHRONOGRAPH_REQUIRE_FSYNC": "true",
            "CHRONOGRAPH_UI": str(ROOT / "ui/dist"),
            "CHRONOGRAPH_DOCS": str(ROOT / "docs"),
        }
        subprocess.run(
            [
                self.binary,
                "admin",
                "create-token",
                "BCI test",
                "admin",
                "1",
                str(self.root / "admin.token"),
            ],
            env=self.env,
            check=True,
            capture_output=True,
        )
        self.client = Client(self.url, (self.root / "admin.token").read_text().strip())
        self.start()

    def start(self):
        self.log = (self.root / "server.log").open("ab")
        self.child = subprocess.Popen(
            [self.binary, "serve"], env=self.env, stdout=self.log, stderr=self.log
        )
        for _ in range(150):
            if self.child.poll() is not None:
                raise RuntimeError((self.root / "server.log").read_text())
            try:
                with urllib.request.urlopen(self.url + "/healthz", timeout=0.2):
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("Disposable service failed readiness")

    def stop(self, crash=False):
        if self.child.poll() is None:
            self.child.kill() if crash else self.child.terminate()
            self.child.wait(timeout=15)
        self.log.close()

    def close(self):
        self.stop()
        self.temp.cleanup()
