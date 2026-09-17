import 'dart:io';
import 'dart:convert';
import 'package:chronograph/chronograph.dart';

Future<void> main() async {
  await for (final line
      in stdin.transform(utf8.decoder).transform(const LineSplitter())) {
    ChronographClient? client;
    try {
      final q = jsonDecode(line) as Map<String, dynamic>;
      client = ChronographClient(q['url'], q['token'],
          timeout: Duration(milliseconds: q['timeout'] ?? 30000),
          maxResponseBytes: q['limit'] ?? 4194304);
      dynamic result;
      if (q['construct'] == true) {
        result = true;
      } else if (q['method'] != null) {
        final bytes = await client.request(q['path'],
            method: q['method'], body: q['body']);
        result = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
      } else {
        result = await client.call(q['op'], q['body'] ?? {});
      }
      stdout.writeln(jsonEncode({'ok': true, 'value': result}));
    } on ApiException catch (e) {
      stdout.writeln(jsonEncode({
        'ok': false,
        'status': e.status,
        'code': e.code,
        'retry': e.retryAfter
      }));
    } catch (e) {
      stdout.writeln(jsonEncode(
          {'ok': false, 'local': true, 'type': e.runtimeType.toString()}));
    } finally {
      client?.close();
    }
  }
}
