import { useState } from "react";
import { Link } from "react-router-dom";
import { graph } from "./api";
import { useAuth } from "./main";
import { useSchema, saveJson } from "./schema-store";
import { Field, Busy } from "./shared";
import "./schema.css";

export default function ConnectorConsole() {
  const { connection } = useAuth();
  const { catalog } = useSchema();
  const bindings = catalog?.connectors ?? [];
  const writable =
    connection?.edition !== "synthetic" &&
    connection?.credential.scope !== "read";
  const [instance, setInstance] = useState("");
  const selected = bindings.find((b) => b.id === instance) ?? bindings[0];
  const [partition, setPartition] = useState("main");
  const [sequence, setSequence] = useState("0");
  const [source, setSource] = useState(
    '[\n  {"src":"1","dst":"2","timestamp_us":"0","assets":{},"fields":{}}\n]',
  );
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edge, setEdge] = useState("0");
  const [asset, setAsset] = useState("");
  const [metadata, setMetadata] = useState(
    '{"version":1,"kind":"tensor","encoding":"raw_le","dtype":"f32","shape":[1],"provenance":{}}',
  );
  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      setResult(JSON.stringify(await work(), null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-panel connector-console">
      <div className="section-head">
        <h2>Connector workspace</h2>
        <Link className="outline" to="/app/schema">
          Configure in migrations
        </Link>
      </div>
      <p>
        Upload binary assets, send normalized records and inspect durable
        checkpoints. Model and device processes run on your own machine.
      </p>
      {!bindings.length ? (
        <div className="notice">
          No connector instances yet. Open Schema → Migrations and choose a
          connector preset.
        </div>
      ) : (
        <>
          <div className="fields two">
            <Field label="Configured instance">
              <select
                aria-label="Configured instance"
                value={selected?.id ?? ""}
                onChange={(e) => setInstance(e.target.value)}
              >
                {bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id} · {b.preset} · kind {b.kind}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Partition">
              <input
                aria-label="Partition"
                value={partition}
                onChange={(e) => setPartition(e.target.value)}
              />
            </Field>
            <Field label="Batch sequence">
              <input
                aria-label="Batch sequence"
                inputMode="numeric"
                value={sequence}
                onChange={(e) => setSequence(e.target.value)}
              />
            </Field>
          </div>
          <p className="small muted">
            Start each partition at 0, then increment after acknowledgment.
            Retry an uncertain request with the same content and sequence. The
            receipt identifies committed edges.
          </p>
          <Field label="Normalized records (JSON array)">
            <textarea
              aria-label="Normalized records (JSON array)"
              className="connector-json"
              rows={8}
              spellCheck={false}
              value={source}
              onChange={(e) => setSource(e.target.value)}
            />
          </Field>
          <div className="schema-actions">
            <button
              className="primary"
              disabled={!writable || busy}
              onClick={() =>
                void run(() =>
                  graph("connector_ingest", {
                    instance: selected?.id,
                    partition,
                    sequence,
                    records: JSON.parse(source),
                  }),
                )
              }
            >
              {busy ? <Busy busy={busy}>Working</Busy> : "Ingest records"}
            </button>
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  graph("connector_checkpoint", {
                    instance: selected?.id,
                    partition,
                  }),
                )
              }
            >
              Read checkpoint
            </button>
          </div>
        </>
      )}
      <details>
        <summary>Upload tensor or binary asset</summary>
        <p>
          Up to 1 MiB per upload. Tensor files contain contiguous little-endian
          bytes; shape and dtype must match. Uploaded files are stored, never
          executed.
        </p>
        <Field label="Asset metadata (JSON)">
          <textarea
            aria-label="Asset metadata (JSON)"
            rows={4}
            value={metadata}
            onChange={(e) => setMetadata(e.target.value)}
          />
        </Field>
        <Field label="Binary asset file">
          <input
            aria-label="Binary asset file"
            type="file"
            disabled={!writable || busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file)
                void run(async () => {
                  if (file.size > 1048576)
                    throw new Error("Asset exceeds 1 MiB.");
                  const bytes = new Uint8Array(await file.arrayBuffer());
                  return graph("asset_put", {
                    metadata: JSON.parse(metadata),
                    data_hex: Array.from(bytes, (b) =>
                      b.toString(16).padStart(2, "0"),
                    ).join(""),
                  });
                });
            }}
          />
        </Field>
      </details>
      <details>
        <summary>Inspect and export</summary>
        <div className="fields two">
          <Field label="Connector edge ID">
            <input
              aria-label="Connector edge ID"
              value={edge}
              onChange={(e) => setEdge(e.target.value)}
            />
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void run(() => graph("connector_record", { edge }))
              }
            >
              Read source record
            </button>
          </Field>
          <Field label="Asset ID">
            <input
              aria-label="Asset ID"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
            />
            <button
              className="outline"
              disabled={busy}
              onClick={() =>
                void run(() => graph("asset_get", { asset, content: true }))
              }
            >
              Read asset
            </button>
          </Field>
        </div>
      </details>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {result && (
        <div aria-live="polite">
          <div className="section-head">
            <h3>Response</h3>
            <button
              className="ghost"
              onClick={() => saveJson(result, "connector-response.json")}
            >
              Export JSON
            </button>
          </div>
          <pre className="connector-json">{result}</pre>
        </div>
      )}
    </section>
  );
}
