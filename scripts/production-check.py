#!/usr/bin/env python3
"""Read-only deployment checks. Never print credentials or remote response bodies."""
import argparse
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def base_url(value):
    parsed = urllib.parse.urlsplit(value)
    try:
        loopback = ipaddress.ip_address(parsed.hostname or '').is_loopback
    except ValueError:
        loopback = parsed.hostname == 'localhost'
    if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback)
            or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment
            or not re.fullmatch(r'(?:/p/[A-Za-z0-9_-]+)?/?', parsed.path)):
        raise ValueError('Use an HTTPS origin or project base; HTTP is loopback-only')
    # Validate the port before any network request.
    _ = parsed.port
    return value.rstrip('/')


def read_token(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'r') as file:
        info = os.fstat(file.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.getuid() or not 1 <= info.st_size <= 512):
            raise ValueError('Token must be a private, owned, nonempty regular file')
        token = file.read().strip()
    if not re.fullmatch(r'cg_[A-Za-z0-9_-]+', token):
        raise ValueError('Token file must contain one graph API key')
    return token


def backup_fresh(path, maximum_hours, now=None):
    info = Path(path).lstat()
    age = (time.time() if now is None else now) - info.st_mtime
    return stat.S_ISREG(info.st_mode) and info.st_size > 0 and -60 <= age <= maximum_hours * 3600


def fetch(url, token=None):
    headers = {'Accept': '*/*', 'User-Agent': 'chronograph-deployment-check/1'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    request = urllib.request.Request(url, headers=headers)
    opener = urllib.request.build_opener(NoRedirect())
    try:
        response = opener.open(request, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise ValueError('Response exceeds probe limit')
        return response.status, response.headers.get('Content-Type', ''), body


def run(args):
    checks = []

    def check(name, fn):
        try:
            passed = bool(fn())
        except (OSError, ValueError, urllib.error.URLError):
            passed = False
        checks.append({'check': name, 'passed': passed})

    base = base_url(args.url)
    token = read_token(args.token_file)
    # Health is host-wide; authenticated stats and metrics test the selected project.
    origin = urllib.parse.urlunsplit(urllib.parse.urlsplit(base)._replace(path=''))
    check('liveness', lambda: fetch(origin + '/healthz')[0] == 200)

    def ready():
        for attempt in range(3):
            if fetch(origin + '/readyz')[0] == 200:
                return True
            if attempt < 2:
                time.sleep(0.25)
        return False

    check('readiness', ready)
    check('anonymous_api_rejected', lambda: fetch(base + '/v1/info')[0] == 401)
    check('anonymous_metrics_rejected', lambda: fetch(base + '/v1/metrics')[0] == 401)

    def api_json(path):
        status, content_type, body = fetch(base + path, token)
        if status != 200 or 'application/json' not in content_type:
            raise ValueError('Unexpected API response')
        value = json.loads(body)
        if not isinstance(value, dict):
            raise ValueError('Expected an object')
        return value

    check('authenticated_api', lambda: bool(api_json('/v1/info').get('version')))
    check('durable_write_policy', lambda: api_json('/v1/info').get('require_fsync') is True)
    check('writer_healthy', lambda: api_json('/v1/stats').get('writer_healthy') is True)

    def metrics():
        status, content_type, body = fetch(base + '/v1/metrics', token)
        lines = body.decode().splitlines()
        return (status == 200 and 'text/plain' in content_type
                and 'chronograph_writer_healthy 1' in lines
                and 'chronograph_fsync_required 1' in lines)

    check('authenticated_metrics', metrics)
    if args.data_dir:
        check('free_disk', lambda: shutil.disk_usage(args.data_dir).free >= args.min_free_gib * 1024**3)
    for index, path in enumerate(args.backup_file):
        check(f'backup_{index + 1}_fresh', lambda path=path: backup_fresh(path, args.max_backup_age_hours))
    return {'ok': all(item['passed'] for item in checks), 'checks': checks,
            'scope': 'Deployment probe; does not establish restore success, off-host backups or high availability'}


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('Must be a finite positive number')
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--data-dir')
    parser.add_argument('--min-free-gib', type=positive, default=5)
    parser.add_argument('--backup-file', action='append', default=[])
    parser.add_argument('--max-backup-age-hours', type=positive, default=8)
    args = parser.parse_args()
    try:
        report = run(args)
    except (ValueError, OSError):
        report = {'ok': False, 'error': 'Invalid endpoint or unreadable/insecure token file'}
    print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
