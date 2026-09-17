# Community alpha.3 SDK validation

Local run: 2026-09-17, macOS ARM64, release server. All seven language clients passed the shared real-server/fault-server conformance suite. See `conformance.json`, `adapters.txt`, existing adapter result files and `connector-platform.json`.

Additional checks: workspace all-feature Rust tests; 3 new domain validator tests; strict Clippy; 5 Python tests; 3 TypeScript tests; OpenAPI 3.1 validation and drift check; 24 desktop/mobile console tests; 8 new documentation viewport/repeat checks; docs/site builds; npm/Python/.NET package contents; release source-boundary validation.

Physical hardware, QPUs and Windows are untested. Julia/R/MATLAB/Swift are extension guidance, not independently implemented SDKs. Q# uses a classical Python host. No packages were uploaded to public package registries.

Latency JSON records warmed loopback HTTP/MCP without TLS on this development machine. Do not treat these numbers as hardware-independent performance or network/cloud SLAs. Native SDK conformance durations measure correctness tests, not per-language throughput.
