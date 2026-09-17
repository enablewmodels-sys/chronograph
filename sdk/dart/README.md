# Dart / Flutter SDK

Dart 3.3+, no third-party dependencies. Add a source dependency in your application's `pubspec.yaml`:

```yaml
dependencies:
  chronograph:
    path: /absolute/path/to/chronograph/sdk/dart
```

```dart
import 'dart:io';
import 'package:chronograph/chronograph.dart';

final client = ChronographClient(Platform.environment['CHRONOGRAPH_URL']!,
    Platform.environment['CHRONOGRAPH_TOKEN']!);
try {
  final page = await client.call('as_of', {'t':'9007199254740993','limit':100});
  print(page);
} finally { client.close(); }
```

Native Dart/Flutter only: `dart:io` excludes Flutter Web. Call `close()` to release sockets. Configure `timeout` and `maxResponseBytes` with named constructor arguments. `ApiException` exposes status, code and retryAfter. `ingest` accepts record maps; `checkpoint` returns the response map. Neither physical device acquisition nor quantum runtime execution is performed by this transport.

This is an alpha.3 source package for the Chronograph Community `/v1` API, not a published package-registry release. Read the [SDK guide](../../docs/SDK.md), [platform recipes](../../docs/INTEGRATIONS.md) and [HTTP API reference](../../docs/API.md).

All IDs and microsecond timestamps are decimal strings. `call` exposes JSON operations; `request` handles GET/DELETE and bounded binary responses. No application write retries are performed. Defaults: 30-second timeout, 4 MiB request/response caps. Remote origins require HTTPS; redirects are rejected. Increase the response cap explicitly for larger Arrow/backup downloads (maximum 256 MiB).

Source-available under [PolyForm Perimeter 1.0.0](LICENSE); preserve [NOTICE](NOTICE). Third-party libraries retain their own licenses.
