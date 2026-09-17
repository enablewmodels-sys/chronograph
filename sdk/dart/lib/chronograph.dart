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
