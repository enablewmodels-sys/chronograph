#!/usr/bin/env python3
"""Build allowlisted source/native release archives from already verified outputs.

No publishing, compilation or deletion of previous releases. Refuses symlinks,
private paths and token/private-key patterns; never traverses runtime directories.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from inventory import generate

ROOT = pathlib.Path(__file__).resolve().parents[2]
VERSION = __import__('tomllib').loads((ROOT / 'Cargo.toml').read_text())['workspace']['package']['version']
TOP = ['Cargo.toml', 'Cargo.lock', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
       'SECURITY.md', 'LICENSE', 'NOTICE', 'Dockerfile', 'vercel.json', '.dockerignore', '.gitignore', 'book.toml']
TREES = ['crates', 'examples', 'scripts', '.github', 'deploy', 'third_party', 'sdk']
UI_TOP = ['package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.ts', 'playwright.config.ts']
FORBIDDEN = {'node_modules', 'target', 'data', 'config', 'community-data', '.work', 'private', '__pycache__', 'secrets', '.git', 'build', 'chronograph_connectors.egg-info'}
FIXTURES = {'crates/chronograph-core/tests/fixtures/v1.cgraph'}
SECRET = re.compile(rb'cg_[a-f0-9]{16}_[a-f0-9]{64}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as src:
        for chunk in iter(lambda: src.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def selected_tree(directory):
    for path in sorted(directory.rglob('*')):
        rel = path.relative_to(ROOT)
        if path.is_dir():
            continue
        if (any(p in FORBIDDEN for p in rel.parts)
                or (rel.parts[0] == 'sdk' and any(p in {'bin', 'obj', 'dist', '.dart_tool'} for p in rel.parts))
                or path.name == '.DS_Store'):
            continue
        if path.is_symlink():
            raise RuntimeError(f'Symlink refused: {rel}')
        if path.name == '.env' or (path.suffix in ('.pyc', '.cgraph', '.token', '.lockfile') and rel.as_posix() not in FIXTURES):
            continue
        yield path


def public_docs(destination):
    destination.mkdir(parents=True, exist_ok=True)
    for path in sorted((ROOT / 'docs').glob('*')):
        if path.suffix in ('.md', '.svg') and path.name not in ('DESIGN.md', 'DELIVERY.md', 'BRANCHING_DESIGN.md'):
            shutil.copy2(path, destination / path.name)
    shutil.copytree(ROOT / 'docs/connectors', destination / 'connectors')


def archive(directory, destination):
    with tarfile.open(destination, 'w:gz', format=tarfile.PAX_FORMAT) as tar:
        for path in sorted(directory.rglob('*')):
            if not path.is_file():
                continue
            if path.is_symlink():
                raise RuntimeError('Symlink refused')
            info = tar.gettarinfo(str(path), arcname=str(path.relative_to(directory.parent)))
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
            with path.open('rb') as stream:
                tar.addfile(info, stream)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--target', required=True)
    parser.add_argument('--bin-dir', type=pathlib.Path, default=ROOT / 'target/release')
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / f'dist/v{VERSION}')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9_-]+', args.target):
        raise RuntimeError('Invalid target')
    args.output.mkdir(parents=True, exist_ok=True)
    source_name = f'chronograph-community-{VERSION}-source'
    native_name = f'chronograph-community-{VERSION}-{args.target}'
    destinations = [args.output / (name + '.tar.gz') for name in (source_name, native_name)]
    if any(p.exists() for p in destinations) or (args.output / 'release-manifest.json').exists():
        raise RuntimeError('Choose a new output directory; existing release artifacts are never replaced')
    for binary in ('chronograph-server', 'chronograph-mcp'):
        if not (args.bin_dir / binary).is_file():
            raise RuntimeError('Missing release binary: ' + binary)
    if not (ROOT / 'ui/dist/index.html').exists() or not (ROOT / 'target/book/index.html').exists():
        raise RuntimeError('Build the UI and mdbook first')
    with tempfile.TemporaryDirectory(prefix='chronograph-package-') as scratch:
        stage = pathlib.Path(scratch)
        source, native = stage / source_name, stage / native_name
        source.mkdir(); native.mkdir()
        paths = [ROOT / p for p in TOP]
        for folder in TREES:
            paths.extend(selected_tree(ROOT / folder))
        paths.extend(ROOT / 'ui' / p for p in UI_TOP)
        for folder in ('ui/src', 'ui/public', 'ui/e2e'):
            paths.extend(selected_tree(ROOT / folder))
        for path in sorted(set(paths)):
            content = path.read_bytes()
            if SECRET.search(content):
                raise RuntimeError('Possible credential/private key: ' + str(path.relative_to(ROOT)))
            dest = source / path.relative_to(ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
        public_docs(source / 'docs')
        (source / 'bench').mkdir()
        for p in ('RESULTS.md', 'run.sh'):
            shutil.copy2(ROOT / 'bench' / p, source / 'bench' / p)
        shutil.copytree(ROOT / 'bench/neo4j', source / 'bench/neo4j', ignore=shutil.ignore_patterns('__pycache__', '.env'))
        # Evidence must be public and sanitized; raw browser traces stay private.
        reports = [ROOT / 'bench/reports' / version for version in ('v0.3.0', 'v0.4.0-alpha.1', 'v0.4.0-alpha.2', f'v{VERSION}')]
        for path in sorted(p for folder in reports for p in folder.rglob('*')):
            if not path.is_file() or path.suffix not in ('.md', '.json', '.csv', '.log', '.txt', '.png'):
                continue
            if SECRET.search(path.read_bytes()):
                raise RuntimeError('Potential secret in evidence: ' + str(path.relative_to(ROOT)))
            dest = source / path.relative_to(ROOT)
            dest.parent.mkdir(parents=True, exist_ok=True)
            if path.suffix in ('.md', '.json', '.csv', '.log', '.txt'):
                # Local evidence remains exact; public copies replace the operator's path only.
                dest.write_text(path.read_text().replace(str(ROOT), '<workspace>'))
            else:
                shutil.copy2(path, dest)
        inventory = stage / 'inventory'
        generate(inventory, args.target)
        for bundle in (source, native):
            for path in inventory.iterdir():
                if path.is_dir(): shutil.copytree(path, bundle / path.name)
                else: shutil.copy2(path, bundle / path.name)
        (native / 'bin').mkdir()
        for binary in ('chronograph-server', 'chronograph-mcp'):
            shutil.copy2(args.bin_dir / binary, native / 'bin' / binary)
        shutil.copytree(ROOT / 'ui/dist', native / 'ui')
        shutil.copytree(ROOT / 'target/book', native / 'manual', ignore=shutil.ignore_patterns('design'))
        public_docs(native / 'docs')
        for p in ('LICENSE', 'NOTICE'):
            shutil.copy2(ROOT / p, native / p)
        shutil.copy2(ROOT / 'scripts/release/chronograph', native / 'chronograph')
        shutil.copy2(ROOT / 'scripts/release/bundle-readme.md', native / 'README.md')
        (native / 'chronograph').chmod(0o755)
        for folder in (source, native):
            hashes = ''.join(f'{digest(p)}  {p.relative_to(folder)}\n' for p in sorted(folder.rglob('*')) if p.is_file())
            (folder / 'FILES.sha256').write_text(hashes)
        for folder, destination in zip((source, native), destinations):
            archive(folder, destination)
        manifest = {'version': VERSION, 'edition': 'community', 'status': 'unsigned Community alpha',
                    'target': args.target, 'publication': 'see GitHub release for published assets',
                    'artifacts': [{'file': p.name, 'bytes': p.stat().st_size, 'sha256': digest(p)} for p in destinations],
                    'sbom': 'SBOM.spdx.json inside each bundle; workspace dependency inventory, not a binary reachability proof',
                    'source_files': sum(p.is_file() for p in source.rglob('*'))}
        (args.output / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (args.output / 'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in destinations + [args.output / 'release-manifest.json']))
        print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
    main()
