#!/usr/bin/env python3
"""Reproducible positive-allowlist download; never copy local credentials/caches."""
from pathlib import Path
import hashlib
import json
import zipfile
root = Path(__file__).resolve().parents[1]
files = [root/'LICENSE',root/'NOTICE',root/'docs/JEV.md',root/'sdk/schema/openapi.json',
         root/'.binder/postBuild',root/'.binder/requirements.txt']
for folder,patterns in {
    'examples/jev':['*.json','*.py','*.mjs','*.md','*.txt','*.ipynb'],
    'sdk/python':['pyproject.toml','README.md','LICENSE','NOTICE'],
    'sdk/python/chronograph_connectors':['*.py'],
    'sdk/typescript':['package.json','package-lock.json','tsconfig.json','README.md','LICENSE','NOTICE'],
    'sdk/typescript/src':['*.ts'],
    'sdk/typescript/dist':['*.js','*.d.ts'],
}.items():
    for pattern in patterns: files.extend((root/folder).glob(pattern))
output=root/'ui/public/downloads'; output.mkdir(exist_ok=True)
archive=output/'chronograph-jev-examples.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
    for p in sorted(set(files)):
        if p.is_symlink() or not p.is_file(): raise ValueError('Expected regular source file')
        data=p.read_bytes()
        if b'-----BEGIN PRIVATE KEY' in data or b'-----BEGIN RSA PRIVATE KEY' in data: raise ValueError('Secret in bundle')
        info=zipfile.ZipInfo(p.relative_to(root).as_posix(),date_time=(2026,9,20,0,0,0))
        info.compress_type=zipfile.ZIP_DEFLATED; info.external_attr=(0o100755 if p.name=='postBuild' else 0o100644) << 16
        z.writestr(info,data)
notebook=output/'jev-decision-history.ipynb'
notebook.write_bytes((root/'examples/jev/jev-decision-history.ipynb').read_bytes())
manifest={p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in (archive,notebook)}
(output/'jev-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
