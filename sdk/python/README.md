# Chronograph connector client and local agent

Install with `python -m pip install ./sdk/python` from the repository root. Python 3.10+; the durable agent supports Linux and macOS. The HTTP client has no third-party dependencies. Optional adapters load their runtimes only when called.

See [the connector guide](../../docs/CONNECTOR_PLATFORM.md) for configuration, API contracts, retry semantics, asset chunking, supported local adapters and limitations. Run the queue tests with `PYTHONPATH=sdk/python python -m unittest discover -s sdk/python/tests -v`.

Compatibility fixtures use MNE 1.13.0, Qiskit 2.5.2, Cirq 1.6.1, PyTorch 2.11.0 and LeRobot 0.6.1. These test file/output interoperability; they do not certify model performance or physical devices.

This SDK is source-available under PolyForm Perimeter 1.0.0. Read [LICENSE](LICENSE) and preserve [NOTICE](NOTICE). Modification and noncompeting commercial use are permitted; competing products, including free ones, are restricted. Optional dependencies retain their own licenses.

See the [polyglot SDK guide](../../docs/SDK.md) and [new integration recipes](../../docs/INTEGRATIONS.md) for BrainFlow, LSL, named model outputs, decoded ROS media, Q# and portable quantum results. The alpha.3 Python source preserves the earlier Client/Spool interfaces and adds `request`, `info`, `ingest`, `pages` and structured error codes.

[Jev & Laya decision-model adapters](../../docs/DECISION_MODELS.md) preserve typed
answers and model provenance. See [Laya](../../docs/LAYA.md) for local/HTTP runtime
setup and [Jev](../../docs/JEV.md) for the TypeSafe integration. Neither adapter
loads models or calls a provider implicitly. Raw JSON attachments are opt-in.


## BCI and binary data

Use your isolated origin or `https://chronodb.co` and a scoped project key.
Managed routes the origin to the key's project; `/p/PROJECT_ID` is not an SDK
constructor URL. Record session `101` first using the [acquisition guide](https://chronodb.co/documentation/BCI).
Load credentials from your private environment, then query a recording:

```python
import os
from chronograph_connectors import Client
from chronograph_connectors.bci import BCIClient
client = Client(os.environ["CHRONOGRAPH_URL"], os.environ["CHRONOGRAPH_TOKEN"])
bci = BCIClient(client, "bci_research")
window = bci.window("101", "eeg", 0, 1_000_000, channels=[0, 1])
for row in bci.records("101", record_type="signal"):
    print(row["edge"])
```

`asset(bytes, ...)` / `read_asset(id)` handle 1 byte–16 MiB of exact binary data.
Chunk lengths, metadata and pagination progress are checked; malformed responses
fail explicitly. Page iteration is incremental with a configurable 1–10,000 page
budget. Stop consuming (or return false from a callback) to stop fetching.

`bci_sessions`, `bci_session`, `bci_records`, `bci_window` and `bci_manifest` are
shared API operations. All model connectors use the same normalized records,
asset helpers and explicit ingest sequence. BrainFlow/LSL device acquisition and
MNE/CSP training run in the Python acquisition service, not in this HTTP client.
