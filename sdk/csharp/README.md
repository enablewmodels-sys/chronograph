# C# / .NET SDK

Requires .NET 8+. Add a project reference to `sdk/csharp/Chronograph/Chronograph.csproj`. NuGet publication has not occurred.

```csharp
using Chronograph;
using System.Text.Json.Nodes;

using var client = new Client(Environment.GetEnvironmentVariable("CHRONOGRAPH_URL")!,
    Environment.GetEnvironmentVariable("CHRONOGRAPH_TOKEN")!);
var page = await client.CallAsync("as_of",
    new JsonObject { ["t"]="9007199254740993", ["limit"]=100 });
Console.WriteLine(page.ToJsonString());
```

`CallAsync`, `RequestAsync`, `IngestAsync` and `CheckpointAsync` accept `CancellationToken`. `ApiException` exposes `Status`, `Code` and `RetryAfter`. The constructor accepts `TimeSpan? timeout` and `int maxResponseBytes`. Reuse a Client for connection pooling; dispose it when finished. `RequestAsync` returns bounded bytes for binary exports. To build a local package, run `dotnet pack sdk/csharp/Chronograph`; the license and notice are included.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.
