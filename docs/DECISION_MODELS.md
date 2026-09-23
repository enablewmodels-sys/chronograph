# Jev & Laya: decisions with a memory

Keep the decision, its probabilities and the graph state around it. ChronoDB
stores results from both hosted Jev inference and locally operated Laya inference
as temporal relationships, through the same Managed and Community database APIs.

| | TypeSafe Jev | Convai Laya |
| --- | --- | --- |
| Inference | External TypeSafe API | Your Python runtime or Laya HTTP server |
| ChronoDB connector | `jev` / `decisions-v1` | `laya` / `decisions-v1` |
| Python binding | `jev_decision` | `laya_decision` |
| TypeScript binding | `jevDecision` | `layaDecision` |
| Provenance | Requested and returned model | Requested/returned model, checkpoint, routing, optional verified revision |
| Example relation kind | `420` | `421` |
| Guide | [Jev setup and examples](JEV.md) | [Laya setup and examples](LAYA.md) |

[Download both integrations](https://chronodb.co/downloads/chronograph-decision-examples.zip)

## A shared workflow

1. Create a project and an admin key for setup. In Community, create a local key.
2. Choose the model's connector in **Schema & migrations**, preview and apply.
3. Run inference in your application; normalize the result with the matching SDK.
4. Ingest using an expiring project ingest key and a stable partition/sequence.
5. Query decision history, join it to observations and record the eventual outcome.

Retain the exact batch before transmission. Retry delivery without recomputing
inference. Probabilities and recorded outcomes support your own evaluation;
ChronoDB does not certify model accuracy or compare unlike latency measurements.

The downloadable examples default to synthetic fixtures and make network calls
only with `--live` or database writes with `--write`. Raw request/response
attachments require an additional explicit option. Model keys and weights are
never stored or executed by the database. A local Laya deployment keeps inference
local; uploading its results to Managed still transfers those records to the
hosted database. Use Community when those records must remain in your environment.

These are two independent integrations. ChronoDB does not silently switch
providers or send Laya inputs to Jev. Build any escalation policy explicitly,
with evaluation and data-transfer approval appropriate to your application.
