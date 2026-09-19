# Chronograph × TypeSafe Jev

Python and TypeScript bindings, runnable examples and a notebook for recording
Choice, Score and Noul decisions in a temporal graph.

Start with `python examples/jev/python_example.py` after installing
`./sdk/python`, or `node examples/jev/typescript_example.mjs` after building the
TypeScript SDK (prebuilt in the downloadable bundle). Both use a **synthetic
fixture** without network access. `--live` explicitly calls TypeSafe's API.
`--write` explicitly persists to Chronograph; `--init` applies the initial
migration. `--attach-inputs` opts into storing raw input and response assets.

See **docs/JEV.md** in this bundle or the repository for full setup, supported
versions, the migration dropdown, authentication, data handling and retry rules.
Use a local notebook for credentials and live inference. The public Binder
notebook needs no credentials and only demonstrates fixture normalization.

The examples annotate a warehouse recording for review; they do not actuate a
robot. Jev and JEPA are distinct models/connectors. No weights are distributed.
The TypeSafe service is external and requires its own API access.

Chronograph code: PolyForm Perimeter 1.0.0, included LICENSE and NOTICE.
TypeSafe SDKs: separate MIT packages installed only when requested.
