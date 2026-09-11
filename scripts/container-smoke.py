#!/usr/bin/env python3
"""Exercise a built container using disposable named volumes and private credentials."""
import argparse
import json
import pathlib
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--image', default='chronograph:ci')
parser.add_argument('--port', type=int, default=18085)
args = parser.parse_args()
name = 'chronograph-test-' + uuid.uuid4().hex[:12]
volumes = [name + '-data', name + '-config']
url = f'http://127.0.0.1:{args.port}'

def docker(*cmd, timeout=60, check=True):
    return subprocess.run(['docker', *cmd], text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=check, timeout=timeout)

def request(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token: headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url + path, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers

def ready():
    for _ in range(60):
        try:
            if request('/healthz')[0] == 200: return
        except OSError: pass
        time.sleep(0.5)
    raise RuntimeError('Container did not become healthy')

try:
    docker('info', '--format', '{{.ServerVersion}}', timeout=8)
    for volume in volumes: docker('volume', 'create', volume)
    docker('run', '--name', name + '-bootstrap', '--network', 'none',
           '--mount', 'type=volume,src=' + volumes[1] + ',dst=/config', args.image,
           'admin', 'create-token', 'container-test', 'admin', '1', '/config/admin.token')
    with tempfile.TemporaryDirectory(prefix='chronograph-container-') as temp:
        token_path = pathlib.Path(temp) / 'admin.token'
        docker('cp', name + '-bootstrap:/config/admin.token', str(token_path))
        token_path.chmod(0o600)
        token = token_path.read_text().strip()
        docker('run', '-d', '--name', name, '--read-only', '--cap-drop', 'ALL',
               '--security-opt', 'no-new-privileges:true', '--pids-limit', '128',
               '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
               '-p', f'127.0.0.1:{args.port}:8080', '-e', 'CHRONOGRAPH_ORIGIN=' + url,
               '--mount', 'type=volume,src=' + volumes[0] + ',dst=/data',
               '--mount', 'type=volume,src=' + volumes[1] + ',dst=/config', args.image)
        ready()
        assert request('/')[0] == 200
        assert request('/docs/connectors/worldmodel.md')[0] == 200
        assert request('/docs/architecture.svg')[0] == 200
        assert request('/v1/info')[0] == 401
        assert request('/v1/info', token=token)[0] == 200
        code, body, _ = request('/v1/fork', {'t': '0', 'name': 'container fork', 'durability': 'fsync'}, token)
        assert code == 200, body
        fork = json.loads(body)['fork']['id']
        docker('restart', '--time', '60', name, timeout=90)
        ready()
        code, body, _ = request('/v1/fork_info', {'fork': fork}, token)
        assert code == 200 and json.loads(body)['fork']['name'] == 'container fork', body
        assert docker('exec', name, 'id', '-u').stdout.strip() == '10001'
        print(json.dumps({'status': 'PASS', 'image': args.image, 'checks': ['private offline bootstrap',
              'non-root read-only container', 'UI and nested docs', 'scoped auth', 'durable fork after restart']}, indent=2))
finally:
    # Only resources bearing this run's unpredictable name are removed.
    for container in (name, name + '-bootstrap'):
        try: docker('rm', '-f', container, check=False, timeout=8)
        except (OSError, subprocess.TimeoutExpired): pass
    for volume in volumes:
        try: docker('volume', 'rm', volume, check=False, timeout=8)
        except (OSError, subprocess.TimeoutExpired): pass
