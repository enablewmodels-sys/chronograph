# ChronoDB × Convai Laya

Offline-first decision history examples for Python and TypeScript/JavaScript.
Start with `python examples/laya/python_example.py` after installing `./sdk/python`,
or `node examples/laya/typescript_example.mjs` after building the TypeScript SDK.

`--live` uses your Laya HTTP service; Python also supports `--runtime local`.
`--write` persists to ChronoDB; `--init` previews/applies the connector migration;
`--attach-inputs` explicitly retains raw request/response JSON. Follow
**docs/LAYA.md** for Managed and Community setup, authentication and limitations.

Fixtures are hand-written, not model output. The notebook is offline and
requires no model downloads. No weights, credentials or hardware controls are
included. Laya runs separately under its own licence; ChronoDB's licence and
NOTICE are included in the download.
