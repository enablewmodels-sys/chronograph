#!/usr/bin/env python3
"""Emit an SPDX 2.3 workspace dependency inventory and upstream license texts.

This is intentionally a superset: Rust default/optional/development dependencies
resolved for the target and npm production packages. It is not a binary reachability
or vulnerability analysis. No absolute build paths or local credentials are emitted.
"""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import uuid
from urllib.parse import quote

ROOT = pathlib.Path(__file__).resolve().parents[2]
VERSION = __import__('tomllib').loads((ROOT / 'Cargo.toml').read_text())['workspace']['package']['version']


def generate(out, target):
    out.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--locked', '--all-features', '--format-version', '1',
        '--filter-platform', target,
    ], cwd=ROOT, text=True))
    packages, notices = [], []
    seen = set()
    docs = out / 'third-party-licenses'
    docs.mkdir(exist_ok=True)
    provenance = ROOT / 'third_party/sources.json'
    if provenance.is_file(): shutil.copy2(provenance, out / 'UPSTREAM-LICENSE-SOURCES.json')

    def component(ecosystem, name, version, license_expr, directory, download, checksum=None):
        key = re.sub(r'[^A-Za-z0-9.-]', '-', f'{ecosystem}-{name}-{version}')
        ident = 'SPDXRef-' + key
        if ident in seen: return
        seen.add(ident)
        if not isinstance(license_expr, str): license_expr = None
        p = {'SPDXID': ident, 'name': name, 'versionInfo': version,
             'downloadLocation': download, 'filesAnalyzed': False,
             'licenseConcluded': 'NOASSERTION', 'licenseDeclared': re.sub(r'\s*/\s*', ' OR ', license_expr) if license_expr else 'NOASSERTION',
             'copyrightText': 'NOASSERTION',
             'externalRefs': [{'referenceCategory': 'PACKAGE-MANAGER', 'referenceType': 'purl',
                               'referenceLocator': f'pkg:{ecosystem}/{quote(name, safe="/")}@{version}'}]}
        if checksum:
            p['checksums'] = [{'algorithm': 'SHA256', 'checksumValue': checksum}]
        packages.append(p)
        found = []
        if directory:
            for candidate in sorted(directory.rglob('*')):
                rel = candidate.relative_to(directory)
                if len(rel.parts) > 3 or not candidate.is_file() or candidate.is_symlink():
                    continue
                if any(part in ('node_modules', 'target', '.git') for part in rel.parts):
                    continue
                if re.match(r'(?i)^(licen[cs]e|copying|copyright|notice|ofl)([._-]|$)', candidate.name):
                    dest = docs / key / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(candidate, dest)
                    found.append(str(dest.relative_to(out)))
        supplemental = ROOT / 'third_party/upstream' / f'{name}-{version}'
        if not found and supplemental.is_dir():
            for candidate in sorted(supplemental.iterdir()):
                if candidate.is_file():
                    dest = docs / key / candidate.name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(candidate, dest)
                    found.append(str(dest.relative_to(out)))
        notices.append({'component': f'{ecosystem}:{name}@{version}',
                        'license': license_expr or 'NOASSERTION', 'source': download, 'texts': found})

    lock = __import__('tomllib').loads((ROOT / 'Cargo.lock').read_text())
    checksums = {(p['name'], p['version']): p.get('checksum') for p in lock['package']}
    for p in metadata['packages']:
        if p['source'] is None:
            continue  # Our own code is covered by the top-level licenses.
        component('cargo', p['name'], p['version'], p.get('license'),
                  pathlib.Path(p['manifest_path']).parent,
                  f"https://crates.io/api/v1/crates/{p['name']}/{p['version']}/download",
                  checksums.get((p['name'], p['version'])))
    npm = json.loads((ROOT / 'ui/package-lock.json').read_text())
    for path, p in npm['packages'].items():
        if not path or p.get('dev'):
            continue
        directory = ROOT / 'ui' / path
        manifest = directory / 'package.json'
        if not manifest.is_file():
            raise RuntimeError(f'Run npm ci before inventory: missing {path}')
        info = json.loads(manifest.read_text())
        component('npm', info['name'], p['version'], p.get('license') or info.get('license'),
                  directory, p.get('resolved', 'NOASSERTION'))
    missing = [n['component'] for n in notices if not n['texts']]
    if missing:
        raise RuntimeError('Missing upstream license texts; supply pinned third_party notices: ' + ', '.join(missing))
    now = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    document = {
        'spdxVersion': 'SPDX-2.3', 'dataLicense': 'CC0-1.0', 'SPDXID': 'SPDXRef-DOCUMENT',
        'name': f'Chronograph-{VERSION}-workspace-dependency-inventory-' + target,
        'documentNamespace': 'https://spdx.org/spdxdocs/chronograph-' + str(uuid.uuid4()),
        'creationInfo': {'created': now, 'creators': [f'Tool: chronograph-inventory-{VERSION}']},
        'comment': __doc__.strip(), 'packages': packages,
        'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relationshipType': 'DESCRIBES',
                           'relatedSpdxElement': p['SPDXID']} for p in packages],
    }
    (out / 'SBOM.spdx.json').write_text(json.dumps(document, indent=2) + '\n')
    (out / 'THIRD-PARTY-NOTICES.json').write_text(json.dumps(notices, indent=2) + '\n')
    text = '# Third-party notices\n\n' + __doc__.strip() + '\n\n'
    for n in notices:
        text += f"- {n['component']}: {n['license']}. Source: {n['source']}. "
        text += ('Texts: ' + ', '.join(n['texts'])) if n['texts'] else 'License expression recorded; no separate license file was distributed in this package.'
        text += '\n'
    (out / 'THIRD-PARTY-NOTICES.md').write_text(text)
    print(f'Inventory: {len(packages)} dependencies, {sum(bool(n["texts"]) for n in notices)} with upstream license texts')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--target', required=True)
    args = parser.parse_args()
    generate(args.output, args.target)
