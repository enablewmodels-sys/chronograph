"""Build the downloadable source kit and run the real polyglot conformance suite."""
from pathlib import Path
import json
import hashlib
import os
import shutil
import subprocess
import tempfile
import zipfile
root = Path(__file__).resolve().parents[2]
archive = root / 'ui/public/downloads/chronodb-sdk-kit.zip'
manifest = json.loads((archive.parent / 'sdk-manifest.json').read_text())[archive.name]
assert hashlib.sha256(archive.read_bytes()).hexdigest() == manifest['sha256']
with tempfile.TemporaryDirectory(prefix='chronodb-sdk-kit-') as temporary:
    path = Path(temporary)
    with zipfile.ZipFile(archive) as z:
        for name in z.namelist():
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            assert not any(p in Path(name).parts for p in ('node_modules', '.env', '.work', 'obj', 'bin', '__pycache__'))
        z.extractall(path)
    source = path / 'sdk'
    # The kit contains public libraries, not internal test drivers. Test those
    # extracted libraries using the same drivers as the source-tree build.
    for part in ('go/cmd', 'csharp/Conformance', 'dart/tool'):
        shutil.copytree(root / 'sdk' / part, source / part,
                        ignore=shutil.ignore_patterns('bin', 'obj', '.dart_tool'))
    tools = path / 'tools'
    tools.mkdir()
    original_tools = Path(os.environ.get('SDK_TOOLS', root / '.work/sdk-tools'))
    env = {**os.environ, 'SDK_SOURCE_ROOT': str(source), 'SDK_TOOLS': str(tools),
           'GSON_JAR': str(original_tools / 'gson.jar'),
           'JSON_INCLUDE': str(original_tools / 'include')}
    subprocess.run(['bash', 'scripts/sdk/build.sh'], cwd=root, env=env, check=True)
    subprocess.run(['node', 'scripts/sdk/conformance.mjs'], cwd=root, env=env, check=True)
print('PASS extracted SDK kit: all client builds and real cross-language conformance')
