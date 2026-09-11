#!/usr/bin/env python3
"""Verify source archive boundaries, hashes and relocatable Cargo metadata."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import tarfile
import tempfile
from package import FORBIDDEN, FIXTURES, SECRET

parser = argparse.ArgumentParser()
parser.add_argument('archive', type=pathlib.Path)
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='chronograph-source-') as temp:
    with tarfile.open(args.archive) as archive:
        for member in archive.getmembers():
            path = pathlib.PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts:
                raise RuntimeError('Unsafe source archive member')
            if set(path.parts[1:]) & FORBIDDEN or path.name in ('.env', 'admin.token', 'auth.json'):
                raise RuntimeError('Private source archive member: ' + member.name)
            if path.suffix == '.cgraph' and pathlib.PurePosixPath(*path.parts[1:]).as_posix() not in FIXTURES:
                raise RuntimeError('Runtime journal in source archive: ' + member.name)
            if SECRET.search(archive.extractfile(member).read()):
                raise RuntimeError('Credential-shaped bytes in source archive')
        archive.extractall(temp, filter='data')
    root, = pathlib.Path(temp).iterdir()
    manifest = (root / 'FILES.sha256').read_text().splitlines()
    for line in manifest:
        expected, rel = line.split('  ', 1)
        assert hashlib.sha256((root / rel).read_bytes()).hexdigest() == expected, rel
    result = subprocess.run(['cargo', 'metadata', '--locked', '--offline', '--no-deps', '--format-version', '1'],
                            cwd=root, capture_output=True, text=True, check=True)
    metadata = json.loads(result.stdout)
    assert len(metadata['workspace_members']) == 8
    assert (root / 'LICENSE').read_text().startswith('# PolyForm Perimeter License 1.0.0')
    assert (root / 'NOTICE').is_file()
    assert not (root / 'LICENSE-MIT').exists()
    assert not (root / 'LICENSE-APACHE').exists()
    # Cargo metadata alone does not notice omitted include_bytes!/include_str! inputs.
    for source in root.rglob('*.rs'):
        for relative in re.findall(r'include_(?:bytes|str)!\(\s*"([^"]+)"', source.read_text()):
            included = (source.parent / relative).resolve()
            assert included.is_relative_to(root) and included.is_file(), (source, relative)
    for package in metadata['packages']:
        assert package['version'] == __import__('tomllib').loads((root / 'Cargo.toml').read_text())['workspace']['package']['version']
        assert pathlib.Path(package['license_file']).read_bytes() == (root / 'LICENSE').read_bytes()
        for target in package['targets']:
            assert pathlib.Path(target['src_path']).is_file()
    subprocess.run(['python3', 'scripts/release/check-docs.py'], cwd=root, check=True, capture_output=True)
    print(json.dumps({'status': 'PASS', 'archive': args.archive.name,
                      'checks': ['regular relative files only', 'no runtime directories or credential patterns',
                                 'all source file checksums', 'offline locked Cargo metadata',
                                 'all 8 workspace members and target files', 'all manual chapters and internal links'],
                      'files_checked': len(manifest)}, indent=2))
