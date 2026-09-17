# Go SDK

Go 1.22+, standard library only. In an application module:

```sh
go get github.com/enablewmodels-sys/chronograph/sdk/go@main
```

```go
package main
import (
    "context"
    "log"
    "os"
    cg "github.com/enablewmodels-sys/chronograph/sdk/go"
)
func main() {
    client, err := cg.New(os.Getenv("CHRONOGRAPH_URL"), os.Getenv("CHRONOGRAPH_TOKEN"), cg.Options{})
    if err != nil { log.Fatal(err) }
    defer client.Close()
    page, err := client.Call(context.Background(), "as_of", cg.Object{"t":"9007199254740993", "limit":100})
    if err != nil { log.Fatal(err) }
    log.Println(page)
}
```

Pin the resolved commit in `go.mod`/`go.sum`; no `sdk/go/v...` release tag is promised yet. For local development use `replace github.com/enablewmodels-sys/chronograph/sdk/go => /absolute/path/to/chronograph/sdk/go`.

`Call` decodes generic numbers as `json.Number`. `APIError` works with `errors.As`. `Ingest` accepts `[]Record` and exact string sequences. Context deadlines/cancellation apply through response reads. One Client may be shared across goroutines; call `Close()` to release its idle connections.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.
