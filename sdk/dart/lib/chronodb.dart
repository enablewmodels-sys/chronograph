import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

class ApiException implements Exception {
  final int status;
  final String code, message;
  final String? retryAfter;
  ApiException(this.status, this.code, this.message, [this.retryAfter]);
  @override
  String toString() => 'HTTP $status $code: $message';
}

/// Native Dart/Flutter transport. No redirect following or implicit write retries.
class ChronographClient {
  final Uri _origin;
  final String _token;
  final Duration timeout;
  final int maxResponseBytes;
  final HttpClient _http = HttpClient();
  bool _closed = false;
  static const maxRequestBytes = 4 * 1024 * 1024;
  ChronographClient(String origin, this._token,
      {this.timeout = const Duration(seconds: 30),
      this.maxResponseBytes = maxRequestBytes})
      : _origin = Uri.parse(origin) {
    if (!['http', 'https'].contains(_origin.scheme) ||
        _origin.host.isEmpty ||
        _origin.userInfo.isNotEmpty ||
        _origin.hasQuery ||
        _origin.hasFragment ||
        !['', '/'].contains(_origin.path)) {
      throw ArgumentError('Use an HTTP(S) origin without credentials or path');
    }
    if (_origin.scheme == 'http' &&
        !['localhost', '127.0.0.1', '::1'].contains(_origin.host)) {
      throw ArgumentError('Remote endpoints require HTTPS');
    }
    if (_token.isEmpty || RegExp(r'[\x00-\x20\x7f]').hasMatch(_token))
      throw ArgumentError('Invalid bearer token');
    if (timeout <= Duration.zero ||
        maxResponseBytes < 1 ||
        maxResponseBytes > 256 * 1024 * 1024)
      throw ArgumentError('Invalid client bounds');
    _http.connectionTimeout = timeout;
    _http.autoUncompress = false;
  }
  void close() {
    _closed = true;
    _http.close(force: true);
  }

  Future<Uint8List> request(String path,
      {String method = 'POST', Map<String, dynamic>? body}) async {
    if (_closed) throw StateError('Client closed');
    if (!RegExp(r'^/v1/[a-z_]+(/[A-Za-z0-9_-]+)?$').hasMatch(path) ||
        !['GET', 'POST', 'DELETE'].contains(method))
      throw ArgumentError('Invalid API path/method');
    final payload = body == null ? null : utf8.encode(jsonEncode(body));
    if (payload != null && payload.length > maxRequestBytes)
      throw ArgumentError('Request exceeds 4 MiB');
    HttpClientRequest? pending;
    bool expired = false;
    Future<Uint8List> send() async {
      final req = await _http.openUrl(method, _origin.replace(path: path));
      pending = req;
      if (expired) {
        req.abort();
        throw TimeoutException('Request deadline exceeded');
      }
      req.followRedirects = false;
      req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $_token');
      if (payload != null) {
        req.headers.contentType = ContentType.json;
        req.contentLength = payload.length;
        req.add(payload);
      }
      final res = await req.close();
      final bytes = BytesBuilder(copy: false);
      await for (final chunk in res) {
        if (bytes.length + chunk.length > maxResponseBytes) {
          req.abort();
          throw ApiException(res.statusCode, 'RESPONSE_LIMIT',
              'Response exceeds configured limit');
        }
        bytes.add(chunk);
      }
      final raw = bytes.takeBytes();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        String code = 'HTTP_ERROR', message = 'Request rejected';
        try {
          final error = jsonDecode(utf8.decode(raw))['error'];
          if (error is Map) {
            code = error['code']?.toString() ?? code;
            message = error['message']?.toString() ?? message;
          }
        } catch (_) {}
        throw ApiException(
            res.statusCode,
            code,
            message.length > 1000 ? message.substring(0, 1000) : message,
            res.headers.value('retry-after'));
      }
      return raw;
    }

    return send().timeout(timeout, onTimeout: () {
      expired = true;
      pending?.abort();
      throw TimeoutException('Request deadline exceeded');
    });
  }

  Future<Map<String, dynamic>> call(String operation,
      [Map<String, dynamic> arguments = const {}]) async {
    if (!RegExp(r'^[a-z_]+$').hasMatch(operation))
      throw ArgumentError('Invalid operation');
    final raw = await request('/v1/$operation', body: arguments);
    try {
      return jsonDecode(utf8.decode(raw)) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException(200, 'INVALID_JSON', 'Expected JSON object response');
    }
  }

  Future<Map<String, dynamic>> ingest(String instance, String partition,
          String sequence, List<Map<String, dynamic>> records) =>
      call('connector_ingest', {
        'instance': instance,
        'partition': partition,
        'sequence': sequence,
        'records': records
      });
  Future<Map<String, dynamic>> checkpoint(String instance, String partition) =>
      call('connector_checkpoint',
          {'instance': instance, 'partition': partition});
}

class Asset {
  final Map<String, dynamic> metadata;
  final Uint8List data;
  Asset(this.metadata, this.data);
}

// Structural JSON equality: object key order is not part of the wire contract.
bool _equalJson(dynamic a, dynamic b) {
  if (a is Map && b is Map)
    return a.length == b.length &&
        a.keys.every((k) => b.containsKey(k) && _equalJson(a[k], b[k]));
  if (a is List && b is List)
    return a.length == b.length &&
        List.generate(a.length, (i) => i).every((i) => _equalJson(a[i], b[i]));
  return a == b;
}

extension ChronographData on ChronographClient {
  Future<String> uploadAsset(
      Uint8List data, Map<String, dynamic> metadata) async {
    const chunk = 1024 * 1024;
    if (data.isEmpty || data.length > 16 * chunk)
      throw ArgumentError('Asset requires 1 byte to 16 MiB');
    Map<String, dynamic> r;
    if (data.length <= chunk) {
      r = await call('asset_put', {
        'metadata': metadata,
        'data_hex': data.map((b) => b.toRadixString(16).padLeft(2, '0')).join()
      });
    } else {
      final chunks = <String>[];
      for (int offset = 0; offset < data.length; offset += chunk) {
        final end = offset + chunk < data.length ? offset + chunk : data.length;
        chunks.add(await uploadAsset(Uint8List.sublistView(data, offset, end),
            {'version': 1, 'kind': 'opaque', 'encoding': 'chunk_v1'}));
      }
      r = await call('asset_compose', {'metadata': metadata, 'chunks': chunks});
    }
    if (r['asset'] is! String || (r['asset'] as String).isEmpty)
      throw StateError('Invalid asset response');
    return r['asset'];
  }

  Future<Asset> readAsset(String id) async {
    const chunk = 1024 * 1024;
    final output = BytesBuilder(copy: false);
    int? expected;
    Map<String, dynamic>? metadata;
    for (int page = 0; page < 16; page++) {
      final r = await call(
          'asset_get', {'asset': id, 'content': true, 'offset': output.length});
      final size = r['bytes'], encoded = r['data_hex'], meta = r['metadata'];
      if (r['asset'] != id ||
          r['offset'] is! int ||
          r['offset'] != output.length ||
          size is! int ||
          size < 1 ||
          size > 16 * chunk ||
          (expected != null && size != expected) ||
          encoded is! String ||
          encoded.isEmpty ||
          encoded.length > 2 * chunk ||
          encoded.length.isOdd ||
          !RegExp(r'^[0-9a-fA-F]+$').hasMatch(encoded) ||
          meta is! Map<String, dynamic> ||
          (metadata != null && !_equalJson(metadata, meta)))
        throw StateError('Invalid asset page');
      output.add(Uint8List.fromList([
        for (int i = 0; i < encoded.length; i += 2)
          int.parse(encoded.substring(i, i + 2), radix: 16)
      ]));
      expected = size;
      metadata = meta;
      if (output.length > size || !r.containsKey('next_offset'))
        throw StateError('Invalid asset length/cursor');
      if (r['next_offset'] == null) {
        if (output.length != size) throw StateError('Truncated asset');
        return Asset(metadata, output.takeBytes());
      }
      if (r['next_offset'] is! int ||
          r['next_offset'] != output.length ||
          output.length >= size)
        throw StateError('Non-progressing asset cursor');
    }
    throw StateError('Asset page limit exceeded');
  }

  Stream<Map<String, dynamic>> pages(String op,
      {Map<String, dynamic> arguments = const {}, int maxPages = 1000}) async* {
    if (maxPages < 1 ||
        maxPages > 10000 ||
        ![
          'as_of',
          'between',
          'history',
          'neighbors',
          'bci_sessions',
          'bci_records'
        ].contains(op)) throw ArgumentError('Invalid pagination options');
    final bci = op.startsWith('bci_'),
        key = op.startsWith('bci_') ? 'after' : 'cursor';
    final args = Map<String, dynamic>.from(arguments);
    final seen = <String>{};
    if (args[key] is String) seen.add(args[key]);
    for (int page = 0; page < maxPages; page++) {
      final r = await call(op, args),
          cursorKey = op == 'bci_records' ? 'cursor' : 'next_cursor';
      if (!r.containsKey(cursorKey))
        throw StateError('Missing pagination cursor');
      final cursor = r[cursorKey];
      bool done = cursor == null;
      if (op == 'bci_records') {
        if (r['has_more'] is! bool) throw StateError('Invalid BCI page');
        done = !r['has_more'];
      }
      if (bci && r[op == 'bci_records' ? 'records' : 'sessions'] is! List)
        throw StateError('Invalid BCI rows');
      if (!done) {
        if (cursor is! String || cursor.isEmpty || !seen.add(cursor))
          throw StateError('Non-progressing pagination cursor');
        args[key] = cursor;
      }
      yield r;
      if (done) return;
    }
    throw StateError('Pagination limit reached');
  }

  Future<Map<String, dynamic>> bciSessions(String instance) =>
      call('bci_sessions', {'instance': instance});
  Future<Map<String, dynamic>> bciSession(String instance, String session) =>
      call('bci_session', {'instance': instance, 'session': session});
  Future<Map<String, dynamic>> bciWindow(String instance, String session,
          String stream, String start, String end,
          {List<int> channels = const []}) =>
      call('bci_window', {
        'instance': instance,
        'session': session,
        'stream': stream,
        'start': start,
        'end': end,
        'channels': channels
      });
  Future<Map<String, dynamic>> bciManifest(
          String instance, List<String> sessions, {String stream = 'eeg'}) =>
      call('bci_manifest',
          {'instance': instance, 'sessions': sessions, 'stream': stream});
}
