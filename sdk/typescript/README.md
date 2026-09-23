# TypeScript / JavaScript SDK

From the repository root, run `npm --prefix sdk/typescript ci` and `npm --prefix sdk/typescript run build`. In your application, use `npm install /absolute/path/to/chronograph/sdk/typescript`. Node 20+; ES modules and TypeScript declarations are included.

```typescript
import { Client, ApiError } from "@chronograph-community/sdk";
const client = new Client(process.env.CHRONOGRAPH_URL!, process.env.CHRONOGRAPH_TOKEN!);
try {
  const page = await client.call("as_of", { t: "9007199254740993", limit: 100 });
  console.log(page);
} catch (error) {
  if (error instanceof ApiError) console.error(error.status, error.code);
  else throw error;
}
```

`uploadAsset(bytes, metadata)` handles 1 MiB chunks up to 16 MiB. `readAsset(id)` validates page progress and total bytes. `pages(operation, arguments, maxPages)` yields bounded query pages; writes can invalidate revision-bound cursors. `request`/`call` accept an optional AbortSignal. `ingest` takes typed `RecordV1[]`; `checkpoint` returns the whole response object.

Browser usage is limited to a same-origin server/proxy; the server intentionally does not enable arbitrary CORS origins. A bearer token in a browser is visible to the user. Never bundle administrative credentials into a public landing page. JavaScript consumers use the identical import from built `dist/index.js`.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.

[Jev & Laya decision-model adapters](../../docs/DECISION_MODELS.md) preserve typed
answers and model provenance. See [Laya](../../docs/LAYA.md) for local/HTTP runtime
setup and [Jev](../../docs/JEV.md) for the TypeSafe integration. Neither adapter
loads models or calls a provider implicitly. Raw JSON attachments are opt-in.
