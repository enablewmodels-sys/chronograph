# TypeSafe Jev: decisions with a history

ChronoDB's `jev` / `decisions-v1` connector stores TypeSafe Jev's **Choice,
Score and Noul** answers as temporal relationships. It preserves the returned
model identifier, requested model, probabilities, confidence where supplied,
usage, source IDs and event timestamp. Jev inference runs in your application;
the graph does not load Jev weights or call TypeSafe on your behalf.

[Download the example bundle](https://chronodb.co/downloads/chronograph-jev-examples.zip) ·
[Download the notebook](https://chronodb.co/downloads/jev-decision-history.ipynb) ·
[Open the fixture notebook in Binder](https://mybinder.org/v2/gh/enablewmodels-sys/chronograph/main?labpath=examples%2Fjev%2Fjev-decision-history.ipynb)

The bundle includes both SDKs, Python and JavaScript examples, a TypeScript
binding, notebook, synthetic request/response fixtures, setup instructions,
license and notices. Binder runs a synthetic example without API credentials;
its availability is operated by mybinder.org, not ChronoDB.

## What is supported

| Surface | Behavior |
| --- | --- |
| Python | `chronograph_connectors.jev.jev_decision` accepts JSON or an official Python SDK response |
| TypeScript / JavaScript | `jevDecision` exported by the ChronoDB SDK accepts TypeSafe's JSON result |
| Migration editor | Family **Decision models**, connector **TypeSafe Jev**, preset **decisions-v1** |
| Other languages | Send the same normalized JSON through any ChronoDB SDK's `connector_ingest` call |
| Attachments | Explicitly upload raw request and response as content-addressed opaque JSON assets |
| Inference | Optional call through TypeSafe's official Python or Node SDK, using your provider key |

This is a decision-record binding, distinct from the JEPA tensor connector. It
supports text/structured-state judgments; it does not turn Jev into a video
encoder, BCI acquisition driver or robot controller. The sample annotates an
offline warehouse replay and sends no commands to hardware.

## Run without either service

From a checkout or extracted download, Python 3.10+:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install ./sdk/python
python examples/jev/python_example.py
```

Node 20+ (the downloadable bundle already contains built SDK files):

```sh
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
node examples/jev/typescript_example.mjs
```

The bundled probabilities are **hand-written fixtures**, not measured Jev
predictions. Every saved record marks its mode as `fixture` or `live`; the
adapter requires the caller to choose explicitly.

## Connect your workspace

Set `CHRONOGRAPH_URL` to your workspace's HTTPS origin and
`CHRONOGRAPH_TOKEN_FILE` to a private file containing its token. Never commit
tokens or put them in notebook output. The initial migration requires admin;
subsequent ingestion can use an ingest token.

```sh
export CHRONOGRAPH_URL=https://your-workspace.example
export CHRONOGRAPH_TOKEN_FILE=/absolute/private/path/ingest.token
# First run only, with an admin token: create connector + relation kind 420.
python examples/jev/python_example.py --write --init --attach-inputs
# Subsequent runs omit --init, or use the Node example:
node examples/jev/typescript_example.mjs --write --attach-inputs
```

`--init` previews and applies the migration through the API. It refuses to
silently replace an existing instance or relation. Alternatively open **Schema
& migrations → Migrations → Start from a connector**, select **Decision models → TypeSafe Jev**,
use instance `jev_decisions`, relation kind `420`, then preview and apply.
`secret_refs: ["TYPESAFE_API_KEY"]` stores only a reference name.

Both examples use exact IDs above JavaScript's safe-integer limit and a fixed
microsecond timestamp representing the original recorded event. Each run uses
a fresh partition with sequence `0`. The API returns a receipt after fsync, and
the example reads the saved record back. For a production producer, persist the
exact normalized batch before sending and retry that same partition/sequence
and body after an uncertain response. Do not rerun inference or generate a new
partition as a delivery retry; use the Python durable spool for queued delivery.

## Run live Jev inference

Obtain access and an API key from [TypeSafe](https://console.typesafe.ai/). Install
its SDK separately and set `TYPESAFE_API_KEY` in your **producer environment**.
The example only calls TypeSafe when `--live` is present. It sets the official
HTTPS endpoint, a 30-second timeout and zero automatic inference retries.
Provider charges and access requirements apply.

```sh
python -m pip install -r examples/jev/requirements.txt
python examples/jev/python_example.py --live --write --attach-inputs
# Or Node:
npm --prefix examples/jev ci
node examples/jev/typescript_example.mjs --live --write --attach-inputs
```

The sample requests `jev-1.13.0`, the version identifier documented on
[TypeSafe's models page](https://docs.typesafe.ai/models) at integration time.
Aliases such as `jev-latest` can change; preserve both requested and returned
identifiers. Do not infer an exact checkpoint if the provider returns an alias.

## Data and validation

- Each record carries 1–64 named answers. Choice/Score distributions must sum
  to one within 0.001; probabilities and confidence must be finite in `[0,1]`.
- Score retains its level legend, probability distribution and expected value.
  Noul stores its probability without inventing a separate confidence.
- The adapter checks answer names/types against the submitted questions. The
  server independently validates the stored decision shape and provenance.
- `input_sha256` fingerprints compact UTF-8 JSON in request insertion order.
  This is not a cross-language canonical-JSON standard or anonymization.
- Raw state/questions are omitted by default. `--attach-inputs` explicitly
  retains the full request and response, accessible to workspace readers and
  included in backups. Avoid placing secrets in state or questions.
- Asset references live in `record.assets.request` and `.response`; retrieve
  through `asset_get` or the SDK's asset-reading helpers. No uploaded JSON is
  executed. No provider credentials are uploaded.

## Verification and limits

Tests cover SDK response normalization, exact IDs, malformed decision rejection,
input privacy, attachment round trips and durable database ingestion. An
upstream SDK test uses mocked HTTP responses. These tests do **not** establish
Jev prediction quality, real inference latency or live provider availability.
A TypeSafe key was not supplied for a paid live inference test.

Sources: [API contract](https://docs.typesafe.ai/api),
[official SDKs](https://docs.typesafe.ai/sdk),
[September 15 launch](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
ChronoDB's adapter is independently maintained; no TypeSafe partnership is implied.
