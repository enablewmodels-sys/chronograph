"""Three synthetic recordings -> frozen dataset -> two real CPU decoder runs.

Run from repository root. Reads CHRONOGRAPH_URL / CHRONOGRAPH_TOKEN from the
local environment. Use a disposable workspace and an admin key for this example.
Never point examples at a participant's production project.
"""

import argparse
import json
import os
from pathlib import Path
from chronograph_connectors.bci import BCITransport as Client
from chronograph_connectors.bci import BCIClient, Session, initialize, save_dataset
from chronograph_connectors.bci_spool import BCISpool
from chronograph_connectors.bci_acquisition import synthetic
from chronograph_connectors.bci_training import train


def run(output):
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    client = Client(
        os.getenv("CHRONOGRAPH_URL", "http://127.0.0.1:8080"),
        os.environ["CHRONOGRAPH_TOKEN"],
    )
    instance = "bci_research"
    initialize(client, instance, clock_domain="simulation_us")
    bci = BCIClient(client, instance)
    ids = []
    queues = []
    sessions = []
    try:
        for i in range(3):
            queue = BCISpool(
                output / f"recording-{i}", instance, f"research_{os.urandom(8).hex()}"
            )
            queues.append(queue)
            session = Session(
                queue,
                clock_domain="simulation_us",
                name=f"Synthetic EEG {i + 1}",
                participant="synthetic",
            )
            sessions.append(session)
            synthetic(session, seconds=48, seed=42 + i)
            queue.drain(client, max_batches=10000)
            ids.append(session.id)
        manifest = client.call(
            "bci_manifest", {"instance": instance, "sessions": ids, "stream": "eeg"}
        )["manifest"]
        (output / "dataset.json").write_text(json.dumps(manifest, indent=2) + "\n")
        dataset = save_dataset(
            client, sessions[0], "Synthetic comparison", manifest, spool=queues[0]
        )
        queues[0].drain(client)
        for components in (2, 4):
            result = train(
                bci,
                manifest,
                output / f"csp-{components}",
                dataset_id=dataset,
                components=components,
            )
            record = sessions[0].record(
                "run",
                0,
                name=f"CSP {components}",
                recipe=result["recipe"],
                dataset_id=dataset,
                status="succeeded",
                result=result,
            )
            queues[0].enqueue([record])
            queues[0].drain(client)
        bci.export(ids[0], "eeg", output / "exact-export")
        print(
            json.dumps(
                {
                    "sessions": ids,
                    "dataset_id": dataset,
                    "output": str(output),
                    "note": "Synthetic workflow verification, not a real EEG performance claim",
                }
            )
        )
    finally:
        for q in queues:
            q.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--output", required=True)
    run(p.parse_args().output)
