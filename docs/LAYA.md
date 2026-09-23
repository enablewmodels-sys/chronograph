# Laya: local decisions with temporal memory

ChronoDB's `laya` / `decisions-v1` connector stores decisions produced by
[Convai Innovations' Laya](https://huggingface.co/convaiinnovations/laya).
Keep Choice, Score and Noul answers, probabilities, model identifiers, checkpoint
and routing metadata alongside the graph state that led to a decision.

Laya inference runs in **your producer environment**. ChronoDB Managed hosts the
database; it does not provision GPUs, download weights or execute your model.
Community uses the same record and migration contract. Jev remains a separate
connector: see the [decision-model guide](DECISION_MODELS.md).

[Download Python & TypeScript examples](https://chronodb.co/downloads/chronograph-decision-examples.zip) ·
[Download the fixture notebook](https://chronodb.co/downloads/laya-decision-history.ipynb) ·
[Open in Binder](https://mybinder.org/v2/gh/enablewmodels-sys/chronograph/main?labpath=examples%2Flaya%2Flaya-decision-history.ipynb)

## Start with an offline fixture

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install ./sdk/python
python examples/laya/python_example.py
# Or Node 20+:
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
node examples/laya/typescript_example.mjs
```

These are hand-written fixtures, explicitly marked `mode: fixture`. They need
no provider credentials, model downloads, database access or network calls.
Binder runs this fixture only; its availability is controlled by mybinder.org.

## Run Laya in your environment

The integration targets the official **Laya 0.3.7** Python runtime and its
`POST /v1/systemone` server. Install the model runtime separately:

```sh
python -m pip install -r examples/laya/requirements.txt
LAYA_HOST=127.0.0.1 LAYA_DEVICE=cpu LAYA_MODELS=english laya-serve
```

Use a separate terminal for the producer. `LAYA_URL` defaults to
`http://127.0.0.1:8000`:

```sh
python examples/laya/python_example.py --live --model english
node examples/laya/typescript_example.mjs --live --model=english
```

For Python without an HTTP server:

```sh
python examples/laya/python_example.py --live --runtime local --model english
```

The runtime downloads weights on first use. Plan disk, memory and device capacity
in your inference environment. The producer accepts `auto`, `english`,
`multilingual` and `typed-decisions`. Automatic routing can load more than one
checkpoint; choose an explicit model when evaluating resource requirements.

The upstream server binds all interfaces and has no authentication by default.
The example above deliberately binds loopback. For a remote deployment, use a
private network or authenticated HTTPS proxy and configure `LAYA_API_KEY` on both
server and producer. Our clients refuse plaintext remote origins and redirects,
use a 30-second request timeout and cap responses at 2 MiB. Provider keys never
enter a ChronoDB record. No inference retries or fallback to Jev occur implicitly.

## Create the database binding

In **Schema & migrations → Start from a connector**, choose **Decision models →
Convai Laya → decisions-v1**. Use `laya_decisions` and an unused relation kind;
the examples use `421`, while Jev uses `420`. Preview, then apply.

Alternatively, create and use the binding from the example:

```sh
export CHRONOGRAPH_URL=https://chronodb.co
export CHRONOGRAPH_TOKEN_FILE=/absolute/private/path/project-admin.token
python examples/laya/python_example.py --write --init --attach-inputs
# Switch to a project ingest key after setup; --init is only needed once.
python examples/laya/python_example.py --live --write --model english
```

For Community, set `CHRONOGRAPH_URL` to its origin, such as
`http://127.0.0.1:8080`. In Managed, the project key selects the database on
`https://chronodb.co`; SDK base URLs use the origin, not the MCP `/p/...` route.
`--init` refuses conflicting existing bindings rather than replacing them.
The example saves and reads back a record after the durable ingestion receipt.
For delivery retries, retain the exact original batch and partition/sequence;
use the Python durable spool instead of repeating inference.

## Use the adapters directly

```python
from chronograph_connectors.laya import laya_decision
record = laya_decision(
    response, request=request, src="9007199254740993",
    dst="9007199254740994", timestamp_us="1700000000000000",
    mode="live",
)
```

```typescript
import { layaDecision } from '@chronograph-community/sdk';
const record = await layaDecision(response, {
  request, src: '9007199254740993', dst: '9007199254740994',
  timestampUs: '1700000000000000', mode: 'live',
});
```

`routing.repo` supplies the checkpoint for Router/HTTP results. For direct Agent
results without routing, pass `checkpoint` explicitly. The generic returned
`laya-rl-agent` name is preserved as reported; it is **not** an exact checkpoint
revision. Pass `checkpoint_revision` (Python), `checkpointRevision` (TypeScript)
or `LAYA_CHECKPOINT_REVISION` (examples) only when verified against your deployed
artifact. Record and pin your own model artifact and runtime for reproducibility.

Raw state and questions stay out of records unless `--attach-inputs` is selected.
That option uploads request and response JSON as content-addressed assets visible
to project readers and included in backups. The input hash is provenance, not
anonymization. Routing reasons and answer metadata can also be sensitive.

## Validation and interpretation

- Exact decimal IDs, finite probabilities, matching question/answer names and
  types, score legends, explicit fixture/live mode and checkpoint provenance.
- Maximum 64 answers, 255 choices, 10 score levels and a 1 MiB input request.
- Laya rounds probabilities to four decimal places. The database permits the
  corresponding bounded sum error and preserves the reported numbers; it does
  not silently renormalize. Jev retains its existing stricter sum check.
- Laya's additional `action` and routing fields are retained. Do not interpret
  `action.act_probability` as a reliable permission to actuate hardware. Evaluate
  the selected checkpoint, language, context length and calibration on your data.

The test suite checks normalization, malformed output, attachments, migration,
ingestion, retries and restart persistence. Protocol tests use an isolated Laya
HTTP fixture; they do not establish model quality, real inference latency or
hardware performance. No weights are redistributed in the examples.

Sources reviewed 23 September 2026: [official source and runtime](https://github.com/NandhaKishorM/laya),
[model card and limits](https://huggingface.co/convaiinnovations/laya),
[PyPI package](https://pypi.org/project/laya/0.3.7/).
Laya's model/runtime licence is independent of ChronoDB's licence. No partnership
or endorsement is implied.
