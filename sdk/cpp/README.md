# C++ SDK

Requires C++17, libcurl and nlohmann/json 3.12. The wrapper is header-only; dependencies are supplied by your build.

```cmake
add_subdirectory(/absolute/path/to/chronograph/sdk/cpp chronograph-sdk)
target_link_libraries(my_producer PRIVATE chronograph::chronograph)
```

```cpp
#include <chronograph/client.hpp>
#include <cstdlib>

// Validate that these environment variables are present in your application.
chronograph::client client(std::getenv("CHRONOGRAPH_URL"), std::getenv("CHRONOGRAPH_TOKEN"));
auto page = client.call("as_of", {{"t", "9007199254740993"}, {"limit", 100}});
```

`chronograph::api_error` provides `status`, `code` and `retry_after`; transport failures use `std::runtime_error`. Optional constructor arguments set milliseconds and maximum response bytes. `request` returns a `std::string` that may contain binary zero bytes. Calls own their curl handles and may run concurrently on one immutable client. TLS verification stays enabled. Asset composition and pagination have bounded helpers; see below.

The test helper downloads nlohmann's header into an ignored directory and verifies its hash. It is not vendored into this package. nlohmann/json is MIT-licensed; libcurl uses its own permissive license.

This is an alpha.3 source package for the ChronoDB Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.


## BCI and binary data

Use your isolated origin or `https://chronodb.co` and a scoped project key.
Managed routes the origin to the key's project; `/p/PROJECT_ID` is not an SDK
constructor URL. Record session `101` first using the [acquisition guide](https://chronodb.co/documentation/BCI).
The following uses the `client` from the connection example above:

```cpp
auto window = client.bci_window("bci_research", "101", "eeg", "0", "1000000", {0, 1});
client.pages("bci_records", {{"instance","bci_research"},{"session","101"}}, 200,
    [](const chronograph::json& page) { /* consume page */ (void)page; return true; });
```

`upload_asset(binary_string, metadata)` / `read_asset(id)` handle 1 byte–16 MiB of exact binary data.
Chunk lengths, metadata and pagination progress are checked; malformed responses
fail explicitly. Page iteration is incremental with a configurable 1–10,000 page
budget. Stop consuming (or return false from a callback) to stop fetching.

`bci_sessions`, `bci_session`, `bci_records`, `bci_window` and `bci_manifest` are
shared API operations. All model connectors use the same normalized records,
asset helpers and explicit ingest sequence. BrainFlow/LSL device acquisition and
MNE/CSP training run in the Python acquisition service, not in this HTTP client.
