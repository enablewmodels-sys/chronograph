#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('probe', Path(__file__).with_name('production-check.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_private_token_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'key'
            path.write_text('cg_test123\n'); path.chmod(0o600)
            self.assertEqual(probe.read_token(path), 'cg_test123')
            link = Path(directory) / 'link'; link.symlink_to(path)
            with self.assertRaises(OSError): probe.read_token(link)
            path.chmod(0o644)
            with self.assertRaises(ValueError): probe.read_token(path)

    def test_url_boundary(self):
        for value in ['http://example.com', 'https://user:pass@example.com',
                      'https://example.com/?secret=x', 'https://example.com/p/../v1',
                      'file:///tmp/token', 'https://example.com:bad']:
            with self.assertRaises(ValueError): probe.base_url(value)
        self.assertEqual(probe.base_url('https://example.com/p/abc/'), 'https://example.com/p/abc')
        self.assertEqual(probe.base_url('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')

    def test_backup_age_and_type(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive'; path.write_bytes(b'archive')
            os.utime(path, (1000, 1000))
            self.assertTrue(probe.backup_fresh(path, 8, now=1001))
            self.assertFalse(probe.backup_fresh(path, 8, now=100000))
            self.assertFalse(probe.backup_fresh(path, 8, now=0))
            link = Path(directory) / 'link'; link.symlink_to(path)
            self.assertFalse(probe.backup_fresh(link, 8))

    def test_http_failures_and_no_redirect(self):
        state = {'fsync': True, 'redirect_hits': 0, 'ready': True}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def do_GET(self):
                status, kind, body = 200, 'application/json', {}
                if self.path == '/redirect':
                    self.send_response(302); self.send_header('Location', '/stolen'); self.end_headers(); return
                if self.path == '/stolen': state['redirect_hits'] += 1
                if '/v1/' in self.path and self.headers.get('Authorization') != 'Bearer cg_test123': status = 401
                elif self.path.endswith('/v1/info'): body = {'version': 'test', 'require_fsync': state['fsync']}
                elif self.path.endswith('/v1/stats'): body = {'writer_healthy': True}
                elif self.path.endswith('/v1/metrics'):
                    kind, body = 'text/plain', 'chronograph_writer_healthy 1\nchronograph_fsync_required 1\n'
                elif self.path == '/readyz' and not state['ready']: status = 503
                self.send_response(status); self.send_header('Content-Type', kind); self.end_headers()
                self.wfile.write((body if isinstance(body, str) else json.dumps(body)).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        try:
            origin = f'http://127.0.0.1:{server.server_port}'
            self.assertEqual(probe.fetch(origin + '/redirect', 'cg_test123')[0], 302)
            self.assertEqual(state['redirect_hits'], 0)
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'key'; path.write_text('cg_test123'); path.chmod(0o600)
                args = SimpleNamespace(url=origin + '/p/test', token_file=path, data_dir=None, backup_file=[])
                self.assertTrue(probe.run(args)['ok'])
                state.update(fsync=False, ready=False)
                result = probe.run(args)
                self.assertFalse(result['ok'])
                failed = {item['check'] for item in result['checks'] if not item['passed']}
                self.assertEqual(failed, {'readiness', 'durable_write_policy'})
        finally:
            server.shutdown(); server.server_close(); worker.join()


if __name__ == '__main__': unittest.main()
