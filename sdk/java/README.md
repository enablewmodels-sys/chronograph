# Java SDK

JDK 17+, Gson 2.14.0. From the repository root: `mvn -f sdk/java/pom.xml install`. This installs to your local Maven repository. Add `io.chronograph:chronograph-community:0.4.0-alpha.3` to your application's dependencies; it is not on Maven Central.

```java
import io.chronograph.Client;
import com.google.gson.JsonObject;

var client = new Client(System.getenv("CHRONOGRAPH_URL"), System.getenv("CHRONOGRAPH_TOKEN"));
var args = new JsonObject();
args.addProperty("t", "9007199254740993");
args.addProperty("limit", 100);
var page = client.call("as_of", args);
```

Reuse one Client for connection pooling. Its synchronous operations may throw `IOException`, `InterruptedException` or `Client.ApiException`. The latter exposes `status`, `code` and `retryAfter`. The optional constructor accepts a `Duration` deadline and maximum response bytes. The custom body subscriber stops oversized responses before collecting them fully. `request(path, method, body)` returns bytes, `ingest` takes a Gson JsonArray, and `checkpoint` returns the response JsonObject. Use `getAsString()` for graph IDs; never `getAsDouble()`.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.


## BCI and binary data

Use your isolated origin or `https://chronodb.co` and a scoped project key.
Managed routes the origin to the key's project; `/p/PROJECT_ID` is not an SDK
constructor URL. Record session `101` first using the [acquisition guide](https://chronodb.co/documentation/BCI).
The following uses the `client` from the connection example above:

```java
var channels = new com.google.gson.JsonArray(); channels.add(0); channels.add(1);
var window = client.bciWindow("bci_research", "101", "eeg", "0", "1000000", channels);
var args = new JsonObject(); args.addProperty("instance", "bci_research"); args.addProperty("session", "101");
client.pages("bci_records", args, 200, page -> { System.out.println(page); return true; });
```

`uploadAsset(byte[], metadata)` / `readAsset(id)` handle 1 byte–16 MiB of exact binary data.
Chunk lengths, metadata and pagination progress are checked; malformed responses
fail explicitly. Page iteration is incremental with a configurable 1–10,000 page
budget. Stop consuming (or return false from a callback) to stop fetching.

`bci_sessions`, `bci_session`, `bci_records`, `bci_window` and `bci_manifest` are
shared API operations. All model connectors use the same normalized records,
asset helpers and explicit ingest sequence. BrainFlow/LSL device acquisition and
MNE/CSP training run in the Python acquisition service, not in this HTTP client.
