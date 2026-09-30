# Changelog

## 0.4.0-alpha.3 — 2026-09-30

- Native Dart 3 / Flutter client for the ChronoDB (Chronograph) Community `/v1` HTTP API.
- `ChronographClient` authenticates with a scoped bearer token and enforces bounded
  request and response sizes, explicit timeouts, HTTPS for remote origins and redirect
  rejection. `ApiException` carries status, error code and `retryAfter`.
- `call` exposes JSON operations, `request` handles GET/DELETE and bounded binary
  responses, and `ingest`/`checkpoint` cover record ingestion and durable receipts.
- Incremental page iteration, BCI session/window helpers and 1 byte–16 MiB binary asset
  upload/read helpers. No physical device acquisition or quantum runtime execution is
  performed by this transport.
- Source-available under PolyForm Perimeter 1.0.0; see LICENSE and NOTICE.
