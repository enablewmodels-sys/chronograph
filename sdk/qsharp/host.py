"""Run the trusted local Bell example and store results in a configured binding.

Requires a qsharp/result-v1 binding. API credentials are read from environment,
never passed to the quantum runtime or included in stored experiment metadata.
"""
import os
from pathlib import Path
from qdk import qsharp
from chronograph_connectors import Client
from chronograph_connectors.adapters import qsharp_result

def bell_shots(shots=100):
    if type(shots) is not int or not 1 <= shots <= 100000:
        raise ValueError("Use 1–100000 local shots")
    qsharp.init()
    qsharp.eval(Path(__file__).with_name("Bell.qs").read_text())
    return qsharp.run("Chronograph.Examples.Bell()",shots=shots)

if __name__ == "__main__":
    client=Client(os.environ["CHRONOGRAPH_URL"],os.environ["CHRONOGRAPH_TOKEN"])
    record=qsharp_result(bell_shots(),src="1",dst="2",timestamp_us="0")
    # A stable sequence is safe only for the exact same batch. For durable retry
    # across process restarts, enqueue this record with the Python Spool first.
    from chronograph_connectors import Spool
    with Spool(os.environ["CHRONOGRAPH_SPOOL"],os.environ["CHRONOGRAPH_INSTANCE"]) as spool:
        spool.enqueue([record])
        print({"committed_batches":spool.drain(client)})
