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

`chronograph::api_error` provides `status`, `code` and `retry_after`; transport failures use `std::runtime_error`. Optional constructor arguments set milliseconds and maximum response bytes. `request` returns a `std::string` that may contain binary zero bytes. Calls own their curl handles and may run concurrently on one immutable client. TLS verification stays enabled. Asset composition/pagination use generic `call` operations; see the shared guide.

The test helper downloads nlohmann's header into an ignored directory and verifies its hash. It is not vendored into this package. nlohmann/json is MIT-licensed; libcurl uses its own permissive license.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.
