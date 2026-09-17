# Q# host bridge

Q# quantum programs do not issue database HTTP requests. A classical Python host runs trusted local code through QDK and persists its output with the Python SDK.

```sh
python -m pip install ./sdk/python qdk==1.32.3
```

Create a `qsharp/result-v1` binding with simulation_us clock through migrations. Supply `CHRONOGRAPH_URL`, an ingest-scoped `CHRONOGRAPH_TOKEN`, `CHRONOGRAPH_INSTANCE` and a private `CHRONOGRAPH_SPOOL` directory through the environment, then run `python sdk/qsharp/host.py` from the repository root.

The included `Bell.qs` operation returns `Int[]` bits. The host aggregates counts without losing integer precision and preserves array bit ordering. A durable spool retains uncertain batches across process restarts. Reuse the same spool for the same partition. Changing experiments creates new records; this example does not resume a simulator's state or submit QPU jobs.

`quantum_source()` can upload Q# source or caller-compiled QIR as opaque artifacts through a separate source binding. The server never evaluates those artifacts. Local QDK 1.32.3 simulation is tested; external quantum providers and physical QPUs are not.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.
