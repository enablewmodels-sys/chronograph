#!/usr/bin/env python3
"""Deterministic SDK source kit; explicit allowlist excludes caches and credentials."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

root = Path(__file__).resolve().parents[1]
files = {root / p for p in ['LICENSE', 'NOTICE', 'sdk/README.md', 'docs/SDK.md', 'docs/BCI.md', 'docs/BCI_TRAINING.md']}
summary = (root / 'docs/SUMMARY.md').read_text()
for chapter in re.findall(r'\]\(([^)]+\.md)\)', summary):
    if not re.fullmatch(r'(?:connectors/)?[a-zA-Z0-9_-]+\.md', chapter):
        raise ValueError('Unexpected documentation path')
    files.add(root / 'docs' / chapter)
files.update((root / 'docs').glob('*.svg'))
patterns = ['sdk/*/README.md', 'sdk/*/LICENSE', 'sdk/*/NOTICE',
 'sdk/python/pyproject.toml', 'sdk/python/chronograph_connectors/*.py',
 'sdk/typescript/package*.json', 'sdk/typescript/tsconfig.json', 'sdk/typescript/src/*.ts', 'sdk/typescript/dist/*.js', 'sdk/typescript/dist/*.d.ts',
 'sdk/java/pom.xml', 'sdk/java/src/main/java/io/chronograph/*.java',
 'sdk/cpp/CMakeLists.txt', 'sdk/cpp/include/chronograph/*.hpp',
 'sdk/go/go.mod', 'sdk/go/*.go',
 'sdk/dart/pubspec.*', 'sdk/dart/lib/*.dart',
 'sdk/csharp/Chronograph/*.cs', 'sdk/csharp/Chronograph/*.csproj',
 'sdk/qsharp/*.py', 'sdk/qsharp/*.qs', 'sdk/schema/*.json', 'sdk/schema/README.md']
for pattern in patterns:
    files.update(root.glob(pattern))
output = root / 'ui/public/downloads'
output.mkdir(exist_ok=True)
archive = output / 'chronodb-sdk-kit.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for path in sorted(files):
        if path.is_symlink() or not path.is_file():
            raise ValueError('Only regular source files can be packaged')
        data = path.read_bytes()
        if b'-----BEGIN PRIVATE KEY' in data or b'-----BEGIN RSA PRIVATE KEY' in data:
            raise ValueError('Private key in SDK kit')
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=(2026, 9, 28, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, data)
manifest = {archive.name: {'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'bytes': archive.stat().st_size}}
(output / 'sdk-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Built SDK source kit with {len(files)} files')
