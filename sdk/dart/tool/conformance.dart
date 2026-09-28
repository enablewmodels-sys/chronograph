import 'dart:io';
import 'dart:typed_data';
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
      if (q['helper'] != null) {
        result = await helper(client, q);
      } else if (q['construct'] == true) {
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

Future<dynamic> helper(ChronographClient c, Map<String, dynamic> q) async {
  final b = Map<String, dynamic>.from(q['body']), h = q['helper'];
  if (h == 'parallel') {
    final results =
        await Future.wait(List.generate(12, (_) => c.call('stats')));
    if (!results.every((r) => r.containsKey('revision')))
      throw StateError('Concurrent response mismatch');
    return results.length;
  }
  if (h == 'upload') {
    final s = b['data_hex'] as String;
    return c.uploadAsset(
        Uint8List.fromList([
          for (int i = 0; i < s.length; i += 2)
            int.parse(s.substring(i, i + 2), radix: 16)
        ]),
        b['metadata']);
  }
  if (h == 'read') {
    final a = await c.readAsset(b['asset']);
    return {
      'metadata': a.metadata,
      'data_hex': a.data.map((x) => x.toRadixString(16).padLeft(2, '0')).join()
    };
  }
  if (h == 'pages') {
    final r = <Map<String, dynamic>>[];
    await for (final page
        in c.pages(q['op'], arguments: b, maxPages: q['max_pages'] ?? 1000)) {
      r.add(page);
      if (r.length == q['stop_after']) break;
    }
    return r;
  }
  if (q['op'] == 'bci_sessions') return c.bciSessions(b['instance']);
  if (q['op'] == 'bci_session')
    return c.bciSession(b['instance'], b['session']);
  if (q['op'] == 'bci_manifest')
    return c.bciManifest(b['instance'], List<String>.from(b['sessions']),
        stream: b['stream']);
  return c.bciWindow(
      b['instance'], b['session'], b['stream'], b['start'], b['end'],
      channels: List<int>.from(b['channels'] ?? []));
}
