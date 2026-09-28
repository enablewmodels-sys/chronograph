#!/usr/bin/env python3
"""Positive-allowlist, reproducible source download with no local data or secrets."""
from pathlib import Path
import hashlib
import json
import zipfile
root=Path(__file__).resolve().parents[1]
files=[root/p for p in ['LICENSE','NOTICE','docs/BCI.md','docs/BCI_TRAINING.md','sdk/python/pyproject.toml','sdk/python/LICENSE','sdk/python/NOTICE','sdk/python/README.md']]
for pattern in ('examples/bci/*.py','examples/bci/*.md','examples/bci/*.ipynb','sdk/python/chronograph_connectors/*.py'):
    files.extend(root.glob(pattern))
output=root/'ui/public/downloads';output.mkdir(exist_ok=True)
archive=output/'chronodb-bci-examples.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
    for p in sorted(files):
        if p.is_symlink() or not p.is_file():raise ValueError('Only regular source files may be bundled')
        data=p.read_bytes()
        if b'-----BEGIN PRIVATE KEY' in data or b'-----BEGIN RSA PRIVATE KEY' in data:raise ValueError('Secret in bundle')
        info=zipfile.ZipInfo(str(p.relative_to(root)),date_time=(2026,9,28,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
        z.writestr(info,data)
notebook=output/'eeg-research.ipynb';notebook.write_bytes((root/'examples/bci/eeg-research.ipynb').read_bytes())
(output/'bci-manifest.json').write_text(json.dumps({p.name:{'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'bytes':p.stat().st_size} for p in (archive,notebook)},indent=2)+'\n')
print('Built BCI source archive, offline notebook and SHA-256 manifest')
