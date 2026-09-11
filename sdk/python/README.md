# Chronograph connector client and local agent

Install with `python -m pip install ./sdk/python` from the repository root. Python 3.10+; the durable agent supports Linux and macOS. The HTTP client has no third-party dependencies. Optional adapters load their runtimes only when called.

See [the connector guide](../../docs/CONNECTOR_PLATFORM.md) for configuration, API contracts, retry semantics, asset chunking, supported local adapters and limitations. Run the queue tests with `PYTHONPATH=sdk/python python -m unittest discover -s sdk/python/tests -v`.

Compatibility fixtures use MNE 1.13.0, Qiskit 2.5.2, Cirq 1.6.1, PyTorch 2.11.0 and LeRobot 0.6.1. These test file/output interoperability; they do not certify model performance or physical devices.

This SDK is source-available under PolyForm Perimeter 1.0.0. Read [LICENSE](LICENSE) and preserve [NOTICE](NOTICE). Modification and noncompeting commercial use are permitted; competing products, including free ones, are restricted. Optional dependencies retain their own licenses.
