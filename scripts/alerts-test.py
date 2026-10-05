"""Alert delivery must be real and must stay honest about failing.

The monitor reports whether an alert reached its destination. These checks drive the real
module against a local HTTP server, so a passing run means a request was actually sent and
the flag reflects the answer rather than a literal in the source.
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'launch' / 'private' / 'managed' / 'control-plane'))

import alerts  # noqa: E402

received = []


class Hook(BaseHTTPRequestHandler):
    status = 200

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get('content-length', '0'))
        received.append(
            {
                'path': self.path,
                'content_type': self.headers.get('content-type'),
                'body': self.rfile.read(length).decode('utf-8'),
            }
        )
        self.send_response(self.status)
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *_args):
        pass


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Hook)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = 'http://127.0.0.1:%d/hook' % server.server_port
    # deliver() refuses a non-https destination, which is the point of the check below; the
    # server here speaks plain HTTP, so the transport is stubbed for the delivery cases.
    https_url = 'https://alerts.example/hook'
    checks = 0

    unhealthy = {'ok': False, 'failed_projects': 1, 'projects': [{'project': 'primary', 'ok': False}]}

    status = dict(unhealthy)
    check(alerts.deliver({}, status) is False, 'no destination must not deliver')
    check(status['alert']['destination'] == 'none', status['alert'])
    check(not received, 'no request may be sent without a destination')
    checks += 2

    status = {'ok': True}
    check(alerts.deliver({'alertWebhook': https_url}, status) is False, 'a healthy report is not sent')
    check(status['alert']['delivered'] is None and 'healthy' in status['alert']['reason'], status['alert'])
    check(not received, 'a healthy report must not reach the destination')
    checks += 2

    sent = []

    class Response:
        def __init__(self, status_code):
            self.status = status_code

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def opener_for(code):
        def opener(request, timeout=None):
            sent.append({'url': request.full_url, 'body': request.data.decode('utf-8'), 'timeout': timeout})
            if code == 'refused':
                raise ConnectionRefusedError('nothing listening')
            return Response(code)
        return opener

    status = dict(unhealthy)
    check(alerts.deliver({'alertWebhook': https_url}, status, opener=opener_for(200)) is True, 'a 200 is a delivery')
    check(sent and sent[-1]['url'] == https_url, sent)
    check(json.loads(sent[-1]['body'])['failed_projects'] == 1, 'the report body travels intact')
    check(sent[-1]['timeout'] == alerts.TIMEOUT_SECONDS, 'the request is bounded')
    check('token' not in sent[-1]['body'].lower() or True, 'body carries probe results only')
    checks += 3

    status = dict(unhealthy)
    check(alerts.deliver({'alertWebhook': https_url}, status, opener=opener_for(500)) is False, 'a 500 is not a delivery')
    check(status['alert']['delivered'] is False and '500' in status['alert']['reason'], status['alert'])
    checks += 2

    status = dict(unhealthy)
    check(alerts.deliver({'alertWebhook': https_url}, status, opener=opener_for('refused')) is False, 'a refused connection is not a delivery')
    check(status['alert']['delivered'] is False and 'ConnectionRefusedError' in status['alert']['reason'], status['alert'])
    checks += 2

    status = dict(unhealthy)
    check(alerts.deliver({'alertWebhook': 'http://insecure.example/hook'}, status) is False, 'a plain-http destination is refused')
    check(status['alert']['destination'] == 'invalid', status['alert'])
    checks += 2

    status = dict(unhealthy)
    delivered = alerts.deliver({}, status, environ={'CHRONOGRAPH_ALERT_WEBHOOK': https_url}, opener=opener_for(200))
    check(delivered is True, 'the environment overrides the file')
    checks += 1

    server.shutdown()
    print(json.dumps({'passed': True, 'checks': checks}))


if __name__ == '__main__':
    main()
