#!/usr/bin/env python3
"""Run final benchmark workloads sequentially and preserve command/timing evidence."""
import datetime as dt
import json
import os
import pathlib
import platform
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[2]
out = root / 'bench/reports/v0.3.0/phase-8-release'
data = root / 'bench/data/v0.3.0/final'
if data.exists():
    raise SystemExit('Refusing to reuse final datasets; choose a new run path in this script')
data.mkdir(parents=True)
out.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, RAYON_NUM_THREADS='10', CHRONOGRAPH_BENCH_REPORT=str(out))
report = {'started_at': dt.datetime.now(dt.timezone.utc).isoformat(),
          'host': platform.platform(), 'threads': 10, 'dataset': 10_000_000,
          'cache': 'warm OS cache; developer host, no isolation', 'commands': []}
commands = []
for mode, flags in [('batch-ordered', []), ('single-ordered', ['--single', '--ingest-only']),
                    ('batch-shuffled', ['--shuffled', '--ingest-only']),
                    ('single-shuffled', ['--single', '--shuffled', '--ingest-only'])]:
    commands.append((mode, ['target/release/measure', *flags], {'CHRONOGRAPH_BENCH_DB': str(data / (mode + '.cgraph'))}))
commands.extend([
    ('criterion', ['cargo', 'bench', '--locked', '--workspace', '--bench', 'engine'], {'CHRONOGRAPH_BENCH_DB': str(data / 'batch-ordered.cgraph')}),
    ('world-model-example', ['target/release/examples/world_model'], {}),
    ('bci-example', ['target/release/examples/bci_stream'], {}),
])
for name, command, extra in commands:
    print('Running ' + name, flush=True)
    start = dt.datetime.now(dt.timezone.utc)
    # /usr/bin/time -l retains actual peak resident bytes on macOS; benchmark timings are internal.
    measured = ['/usr/bin/time', '-l', *command] if sys.platform == 'darwin' else command
    with (out / (name + '.log')).open('w') as log:
        log.write('$ ' + ' '.join(command) + '\n'); log.flush()
        result = subprocess.run(measured, cwd=root, env={**env, **extra}, stdout=log, stderr=subprocess.STDOUT)
    report['commands'].append({'name': name, 'command': command, 'environment': extra,
                              'exit_code': result.returncode,
                              'seconds': (dt.datetime.now(dt.timezone.utc)-start).total_seconds()})
    (out / 'benchmark-run.json').write_text(json.dumps(report, indent=2) + '\n')
    lines = (out / (name + '.log')).read_text().splitlines()
    print('\n'.join([x for x in lines if any(w in x for w in ['Ingest:', 'traversal:', 'edges/s', 'Reopen:', 'Arrow:', 'resident set size'])]), flush=True)
    if result.returncode: raise SystemExit(result.returncode)
print('All final benchmark commands completed', flush=True)
