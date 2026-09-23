"""Bounded Laya HTTP producer; refuses redirects and plaintext remote credentials."""
import http.client
import json
import os
from urllib.parse import urlsplit


def predict(request):
    base = urlsplit(os.environ.get('LAYA_URL', 'http://127.0.0.1:8000'))
    if (base.scheme not in ('http', 'https') or not base.hostname or base.username or base.password
            or base.path not in ('', '/') or base.query or base.fragment
            or (base.scheme == 'http' and base.hostname not in ('127.0.0.1', 'localhost', '::1'))):
        raise ValueError('LAYA_URL must be an HTTPS origin or loopback HTTP origin')
    headers = {'Content-Type': 'application/json'}
    key = os.environ.get('LAYA_API_KEY')
    if key:
        if any(ord(c) <= 32 or ord(c) == 127 for c in key):
            raise ValueError('Invalid Laya API key format')
        headers['Authorization'] = 'Bearer ' + key
    cls = http.client.HTTPSConnection if base.scheme == 'https' else http.client.HTTPConnection
    connection = cls(base.hostname, base.port, timeout=30)
    try:
        connection.request('POST', '/v1/systemone', json.dumps(request, allow_nan=False).encode(), headers)
        reply = connection.getresponse()
        if reply.status != 200:
            raise RuntimeError('Laya returned HTTP %s; inspect your local inference service' % reply.status)
        data = reply.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('Laya response exceeds 2 MiB')
        return json.loads(data)
    finally:
        connection.close()
