"""Generate a disclosed synthetic training fixture in an explicitly selected test workspace."""

import argparse, json, time
from pathlib import Path
from chronograph_connectors import Client, ApiError
from chronograph_connectors.bci import Session, BCIClient, initialize, save_dataset
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import synthetic

p = argparse.ArgumentParser()
p.add_argument("--url", required=True)
p.add_argument("--token-file", required=True)
p.add_argument("--root", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()


class RetryClient(Client):
    def call(self, *args, **kwargs):
        for attempt in range(5):
            try:
                return super().call(*args, **kwargs)
            except ApiError as error:
                if error.status != 429 or attempt == 4:
                    raise
                time.sleep(min(60, max(1, float(error.retry_after or 60))))


c = RetryClient(a.url, Path(a.token_file).read_text().strip())
initialize(c, clock_domain="simulation_us")
ids = []
for i in range(3):
    with BCISpool(Path(a.root) / f"spool{i}", "bci_research", f"fixture{i}") as q:
        s = Session(
            q,
            clock_domain="simulation_us",
            session_id=str(700 + i),
            name=f"Synthetic motor imagery {i + 1}",
        )
        synthetic(s, seconds=48, seed=51 + i)
        q.drain(c, max_batches=1000)
        ids.append(s.id)
manifest = c.call(
    "bci_manifest", {"instance": "bci_research", "sessions": ids, "stream": "eeg"}
)["manifest"]
with BCISpool(Path(a.root) / "spool0", "bci_research", "fixture0") as q:
    s = Session(q, clock_domain="simulation_us")
    did = save_dataset(c, s, "Three-session synthetic baseline", manifest, spool=q)
    q.drain(c)
Path(a.output).write_text(
    json.dumps(
        {
            "instance": "bci_research",
            "session": ids[0],
            "datasetId": did,
            "manifest": manifest,
        }
    )
)
print("Synthetic recording fixture ready (three sessions and frozen dataset).")
