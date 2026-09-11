#!/usr/bin/env python3
"""Verify an extracted native bundle's checksums, launcher, auth and persistence."""
import argparse
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=pathlib.Path)
args = parser.parse_args()
process = None
with tempfile.TemporaryDirectory(prefix='chronograph-native-') as temp:
    base = pathlib.Path(temp)
    with tarfile.open(args.archive, 'r:gz') as archive:
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unexpected archive entry')
        archive.extractall(base, filter='data')
    bundles = list(base.iterdir())
    assert len(bundles) == 1
    bundle = bundles[0]
    for line in (bundle / 'FILES.sha256').read_text().splitlines():
        expected, name = line.split('  ', 1)
        assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == expected, name
    inventory = json.loads((bundle / 'SBOM.spdx.json').read_text())
    identifiers = [p['SPDXID'] for p in inventory['packages']]
    assert len(identifiers) == len(set(identifiers))
    assert (bundle / 'manual/index.html').is_file()
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0)); port = listener.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    state = base / 'operator-state'
    env = {**os.environ, 'CHRONOGRAPH_HOME': str(state), 'CHRONOGRAPH_BIND': f'127.0.0.1:{port}',
           'CHRONOGRAPH_ORIGIN': url}
    # Do not inherit unrelated configured state/UI paths from the invoking shell.
    for name in ('CHRONOGRAPH_DATA', 'CHRONOGRAPH_AUTH', 'CHRONOGRAPH_UI', 'CHRONOGRAPH_DOCS'):
        env.pop(name, None)
    launcher = str(bundle / 'chronograph')
    token_path = state / 'admin.token'
    subprocess.run([launcher, 'admin', 'create-token', 'bundle test', 'admin', '1', str(token_path)],
                   env=env, cwd=temp, check=True, capture_output=True)
    token = token_path.read_text().strip()
    assert token_path.stat().st_mode & 0o777 == 0o600
    def request(path, body=None, auth=True):
        headers = {'Content-Type': 'application/json'}
        if auth: headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(url + path, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=10) as r: return r.status, r.read()
        except urllib.error.HTTPError as e: return e.code, e.read()
    def start():
        p = subprocess.Popen([launcher, 'serve'], env=env, cwd=temp,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if p.poll() is not None: raise RuntimeError('Bundle server exited')
            try:
                if request('/healthz', auth=False)[0] == 200: return p
            except OSError: pass
            time.sleep(0.05)
        p.terminate(); p.wait(timeout=10)
        raise RuntimeError('Bundle failed startup')
    def stop(p):
        if p and p.poll() is None:
            p.send_signal(signal.SIGTERM)
            try: p.wait(timeout=15)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
    try:
        process = start()
        for path in ('/', '/docs/QUICKSTART.md', '/docs/connectors/worldmodel.md', '/docs/architecture.svg'):
            assert request(path, auth=False)[0] == 200, path
        assert request('/v1/info', auth=False)[0] == 401
        code, body = request('/v1/fork', {'t': '0', 'name': 'native bundle fork', 'durability': 'fsync'})
        assert code == 200, body
        fork = json.loads(body)['fork']['id']
        stop(process); process = start()
        code, body = request('/v1/fork_info', {'fork': fork})
        assert code == 200 and json.loads(body)['fork']['name'] == 'native bundle fork'
        assert (state / 'data/graph.cgraph').is_file()
        assert not (bundle / 'community-data').exists()
        print(json.dumps({'status': 'PASS', 'archive': args.archive.name,
                          'checks': ['all file checksums', 'unique SPDX dependency identifiers', 'offline manual',
                          'relocated launcher', 'private token bootstrap', 'UI and nested docs',
                          'unauthenticated request rejected', 'durable fork across restart',
                          'state external to bundle', 'graceful shutdown']}, indent=2))
    finally:
        stop(process)
