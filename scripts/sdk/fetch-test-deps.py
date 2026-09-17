"""Download pinned public test dependencies into an ignored local directory."""
import hashlib
import os
from pathlib import Path
import sys
from urllib.request import urlopen
root=Path(os.environ.get("SDK_TOOLS",".work/sdk-tools"))
files=[
    ("gson.jar","https://repo.maven.apache.org/maven2/com/google/code/gson/gson/2.14.0/gson-2.14.0.jar","2cbd119bf1961c28788310963dc80ba65f58cdeec1dd139c8bdb1240faa2c36f"),
    ("include/nlohmann/json.hpp","https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp","aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63"),
]
if "--linux-lsl" in sys.argv:
    files.append(("liblsl.deb","https://github.com/sccn/liblsl/releases/download/v1.17.7/liblsl-1.17.7-noble_amd64.deb","9cac7570c2b256077b86c011ffa44b7a40344f2271cc353120c387fb9134ddf1"))
for name,url,expected in files:
    path=root/name
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==expected:
        continue
    with urlopen(url,timeout=60) as response:
        data=response.read(8*1024*1024+1)
    if len(data)>8*1024*1024 or hashlib.sha256(data).hexdigest()!=expected:
        raise RuntimeError("Dependency checksum mismatch: "+name)
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(data)
    print("Verified",name)
