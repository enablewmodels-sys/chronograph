# Chronograph Community SDKs

Clients share the `/v1` HTTP contract and normalized connector records. They connect to your own Community server; model inference, acquisition and quantum execution stay in the producer process.

The generated OpenAPI contract is in `schema/openapi.json`. Python also offers a durable SQLite producer spool and optional domain adapters. TypeScript builds JavaScript plus declarations. Q# uses the Python host bridge: quantum code does not perform network requests.

See the language READMEs and [the SDK guide](../docs/SDK.md) for setup, bounds, compatibility and test results. IDs and microsecond timestamps are decimal strings in every language. There are no implicit retries of writes. Use explicit `fsync` durability and retain uncertain connector batches until their receipts are resolved.

All Chronograph SDK code is covered by the root PolyForm Perimeter 1.0.0 LICENSE and NOTICE. Third-party libraries retain their own licenses. Package registry publication is separate from source distribution.

- [python](./python/README.md)
- [typescript](./typescript/README.md)
- [java](./java/README.md)
- [cpp](./cpp/README.md)
- [go](./go/README.md)
- [dart](./dart/README.md)
- [csharp](./csharp/README.md)
- [qsharp](./qsharp/README.md)
