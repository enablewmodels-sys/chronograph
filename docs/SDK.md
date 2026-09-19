# Language SDKs

The Community repository contains Python, TypeScript/JavaScript, Java, C++, Go, Dart and C# clients. Q# uses a Python host bridge. Rust applications can embed `chronograph-db` directly. All HTTP clients use the same authenticated `/v1` API; the server owns validation, transactions and connector checkpoints.

These are **alpha.3 source packages on `main`**, not packages published to npm, PyPI, Maven Central, NuGet or pub.dev. The alpha.2 release downloads predate the new clients and five new connector descriptors. Build the current checkout for the complete catalog. Existing `/v1` operations remain compatible with alpha.2.

## Choose a client

| Language | Requirements and source directory | Included facilities |
| --- | --- | --- |
| Python | Python 3.10+, `sdk/python` | Dependency-free transport, asset chunking, bounded page iteration, NumPy/PyTorch adapters, durable SQLite spool on Linux/macOS |
| TypeScript / JavaScript | Node 20+, `sdk/typescript` | Fetch transport, declarations, asset chunking, page iteration, abort signals; browser use requires a same-origin deployment |
| Java | JDK 17+, Gson 2.14.0, `sdk/java` | Reusable JDK HTTP client, bounded response subscriber, generic JSON operations and binary responses |
| C++ | C++17, libcurl, nlohmann/json 3.12, `sdk/cpp` | Header-only wrapper, generic JSON operations, bounded binary transfers and deadlines |
| Go | Go 1.22+, `sdk/go` | Standard-library transport, contexts, structured records, reusable connection pool; JSON numbers decoded as `json.Number` |
| Dart | Dart 3.3+, `sdk/dart` | Native Dart/Flutter transport, async calls, binary responses; uses `dart:io`, so Flutter Web is not supported |
| C# | .NET 8+, `sdk/csharp/Chronograph` | `System.Text.Json` nodes, async calls, cancellation tokens, owned HTTP connection pool |
| Q# | QDK Python package, `sdk/qsharp` | Trusted local Bell program and Python host that persists simulated results through the Python client |
| Rust | Rust 1.93+, `crates/chronograph-core` | Embedded engine and native connector crates; no HTTP boundary required |

Java, C++, Go, Dart and C# expose `call`/`CallAsync` for every JSON operation and `request`/`RequestAsync` for GET/DELETE and binary endpoints. Their `ingest` and `checkpoint` helpers build normalized requests. Asset chunking, migration orchestration and pagination can be implemented with those operations; automatic high-level helpers for these are currently provided in Python and TypeScript only.

Each directory has an installation example. [Browse SDK source and per-language guides](https://github.com/enablewmodels-sys/chronograph/tree/main/sdk).

## Install from this checkout

Run these commands from the repository root, selecting the language you need:

```sh
# Python: use your own virtual environment.
python -m pip install ./sdk/python

# TypeScript/JavaScript: build before adding the local package to your app.
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
# In your app: npm install /absolute/path/to/chronograph/sdk/typescript

# Java: installs into your local Maven repository, not Maven Central.
mvn -f sdk/java/pom.xml install

# C#: reference the source project from your application.
dotnet add /path/to/MyApp.csproj reference sdk/csharp/Chronograph/Chronograph.csproj
```

For Go, use `go get github.com/enablewmodels-sys/chronograph/sdk/go@main`, or a local `replace` directive during development. Pin the resolved commit in production. Dart applications use a `path:` dependency on `sdk/dart`. CMake applications use `add_subdirectory` on `sdk/cpp`, then link `chronograph::chronograph`; install libcurl and nlohmann/json first.

Every source package includes the project license and notice. Dependencies retain their own licenses. See [permitted use](LICENSING.md).

## Connect and preserve exact values

Create a scoped token through the [access console or CLI](SECURITY.md). Use a producer token with `ingest` scope; migration apply requires a separate administrator token. Read secrets from your application's secret store or environment. Avoid logging request headers or complete client configuration.

```python
import os
from chronograph_connectors import Client

client = Client(os.environ["CHRONOGRAPH_URL"], os.environ["CHRONOGRAPH_TOKEN"])
stats = client.call("stats")
page = client.call("as_of", {"t": "9007199254740993", "limit": 100})
```

```typescript
import { Client } from "@chronograph-community/sdk";
const client = new Client(process.env.CHRONOGRAPH_URL!, process.env.CHRONOGRAPH_TOKEN!);
const page = await client.call("as_of", { t: "9007199254740993", limit: 100 });
```

Node IDs, edge IDs, fork IDs, revisions, ingestion sequences and microsecond timestamps cross JSON as **decimal strings**. Never pass them through a JavaScript `number`, floating-point spreadsheet cell or an SDK's generic numeric converter. Relation kinds, page sizes, tensor dimensions and migration `expected_revision` are ordinary bounded JSON integers. Field values can contain nested JSON; platform adapters use strings for quantum shot counts too.

## Migrations, assets and reliable ingestion

1. Ask `connector_catalog` for the authoritative server catalog. Choose a connector and preset; the migration UI uses this same catalog.
2. Call `connector_template` with an unused relation kind and an explicit clock domain. Save its `source` as the migration file.
3. Send `source` to `schema_preview`. Review the result, then use an administrator client to call `schema_apply` with that exact source, returned checksum and `expected_revision`.
4. Upload referenced assets. A single `asset_put` accepts at most 1 MiB of decoded bytes. Larger assets use immutable `chunk_v1` uploads and `asset_compose`, at most 16 chunks / 16 MiB total. Tensor bytes are contiguous, row-major and little-endian.
5. Call `connector_ingest` with 1–500 records, a stable partition and decimal sequence starting at `"0"`. Each acknowledged batch has a durable `fsync` receipt.
6. Retain the exact batch until its receipt is known. An identical retry of the **latest** batch returns that receipt. Older sequences, gaps or a changed body fail with 409. Do not run multiple independent writers against one partition.

```python
from chronograph_connectors import Spool
from chronograph_connectors.adapters import record

# Binding "observations" must already exist. The directory is created private.
with Spool("/private/producer-state", "observations", "robot_1") as spool:
    spool.enqueue([record("9007199254740993", "9007199254740994", "0",
                          fields={"source": "example"})])
    committed_batches = spool.drain(client)
```

The Python spool preserves pending batches and sequences across process restarts, including a lost acknowledgment. Reuse the same private directory. Spool persistence covers normalized records and asset IDs; upload all referenced assets successfully before enqueueing. Files, source model checkpoints and hardware queues remain producer responsibilities.

Raw `add_edges` calls have no idempotency key. None of these SDKs automatically retry writes. A timeout can mean the server committed the request; follow the operation's retry contract instead of blindly resending. See [API semantics](API.md) and [connector transactions](CONNECTOR_PLATFORM.md).

## Errors and resource controls

Remote HTTP endpoints are rejected; use HTTPS except for exact localhost origins. Clients reject credentials embedded in URLs, unsafe paths and control characters in bearer tokens. Redirects are rejected so credentials do not follow a moved endpoint. Native TLS certificate verification stays enabled. Credentials in browser JavaScript are visible to that browser user; do not embed administrator tokens in a public site.

Clients cap request bodies at 4 MiB and responses at 4 MiB by default. The configurable response cap permits up to 256 MiB for exports/backups; downloads are buffered within that bound. Python's timeout is socket inactivity; the other clients apply a request deadline. TypeScript and C# accept cancellation signals/tokens; Go uses contexts. Release client resources with Go `Close`, Dart `close` and C# `Dispose`.

API error types expose HTTP status, server `code` and `Retry-After` when present. Oversized responses use `RESPONSE_LIMIT`; malformed successful JSON uses `INVALID_JSON`. Transport failures and local argument validation retain the language's standard exception/error conventions. Non-JSON proxy errors remain HTTP errors and do not expose arbitrary gateway text.

Python `checkpoint()` returns the nested receipt or `None`; other clients return the complete response object with its `checkpoint` field. This preserves compatibility with the original Python agent.

## Machine-readable API and extension languages

The [OpenAPI 3.1 contract](https://github.com/enablewmodels-sys/chronograph/blob/main/sdk/schema/openapi.json) is generated from the same request schemas used by MCP. It covers authenticated REST operations, common record/asset metadata schemas and the connector catalog. Responses are extensible JSON objects; the specification does **not** promise complete generated response DTOs. The [HTTP API guide](API.md) documents response semantics and limits.

Regenerate it after a contract change:

```sh
cargo run --locked -q -p chronograph-server --example export_openapi > sdk/schema/openapi.json
python scripts/sdk/verify-contract.py
```

Swift, Kotlin, Julia, R, MATLAB and other producers can use HTTPS plus JSON or generate a starting client from this contract. Preserve decimal strings, TLS, explicit clocks, bounded bodies and retry semantics when adding a language. These languages do not yet have independently tested first-party SDKs. Q#, OpenQASM and QIR artifacts travel through a classical host; the database never evaluates uploaded quantum source.

## Verification and contributing

`scripts/sdk/conformance.mjs` drives each actual language client against a fresh Rust server. It checks scoped auth, migrations, Unicode, IDs above 2^53, binary tensors, durable retry/conflict, checkpoints, binary Arrow export and input rejection. A controlled HTTP fixture checks redirects, deadlines, response caps, malformed JSON, non-JSON gateway errors and Retry-After. Python/TypeScript also roundtrip a multi-chunk asset.

The `SDK conformance` GitHub workflow builds all seven clients and runs runtime adapter fixtures. Reproduce locally:

```sh
python scripts/sdk/fetch-test-deps.py
python -m pip install -r scripts/sdk/requirements.txt
cargo build --locked -p chronograph-server --bins --example export_openapi
scripts/sdk/build.sh
PYTHONPATH=sdk/python python -m unittest discover -s sdk/python/tests -v
npm --prefix sdk/typescript test
CHRONOGRAPH_TEST_PROFILE=target/debug node scripts/sdk/conformance.mjs
CHRONOGRAPH_TEST_PROFILE=target/debug node scripts/sdk/adapters.mjs
```

Install Go, JDK, libcurl, a C++ compiler, Dart and .NET first. `GO`, `DOTNET`, `SDK_TOOLS`, `GSON_JAR`, `JSON_INCLUDE`, `SDK_PYTHON` and `SDK_LANGUAGES` let the scripts use isolated tools. Linux pylsl needs liblsl; the workflow pins and verifies the Ubuntu 24.04 package. LSL fixtures discover only a random local test source with the supplied loopback config.

Local validation used Python 3.12/3.14, Node 20.20, Go 1.27.1, JDK 25 with Java 17 target, Apple Clang, Dart 3.11.5 and .NET SDK 8.0.425 on macOS ARM64. Windows has not been exercised. Synthetic device/local simulator tests do not certify physical devices, cross-host clock accuracy, clinical performance, model quality or QPU behavior.

## Jev decision binding

Python exports `chronograph_connectors.jev.jev_decision`; TypeScript exports
`jevDecision`. Both retain TypeSafe Jev typed answers and provenance in normalized
records, with optional raw JSON attachments. See [Jev examples](JEV.md).
