import { useEffect, useRef, useState } from "react";
import { Download, Play } from "lucide-react";
import { download, endTime, graph, type QueryResult } from "./api";
import { GraphView, type GraphSelection } from "./GraphView";
import { useWorkspace } from "./workspace";
import { useAuth } from "./main";
import { Busy, Field, Head, SubmitForm, useAction } from "./shared";
const initial = {
  mode: "as_of",
  t: "2000000",
  start: "0",
  end: "4000000",
  node: "1005",
  limit: 100,
  k: 10,
  strategy: "latest",
  seed: "42",
};
export default function Explorer() {
  const { fork, forks } = useWorkspace();
  const { connection } = useAuth();
  const synthetic = connection?.edition === "synthetic";
  const currentFork = useRef(fork);
  currentFork.current = fork;
  const target = forks.find((f) => f.id === fork);
  const requestSequence = useRef(0);
  const [queryError, setQueryError] = useState("");
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [form, setForm] = useState(initial),
    [submitted, setSubmitted] = useState(initial),
    [result, setResult] = useState<QueryResult | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    action = useAction();
  const update = (key: string, value: string | number) =>
    setForm((f) => ({ ...f, [key]: value }));
  const run = async (values = form, next: string | null = null) => {
    const ticket = ++requestSequence.current;
    setQueryError("");
    try {
      const r = await graph<QueryResult>("query", {
        ...values,
        cursor: next,
        ...(fork ? { fork } : {}),
      });
      if (currentFork.current !== fork || ticket !== requestSequence.current)
        return;
      setSelection(null);
      setResult(r);
      setSubmitted(values);
      setCursor(next);
    } catch (error) {
      if (currentFork.current === fork && ticket === requestSequence.current)
        throw error;
    }
  };
  useEffect(() => {
    let active = true;
    setResult(null);
    setSelection(null);
    setCursor(null);
    const start = fork ? target?.timestamp || initial.t : initial.t;
    const values = { ...initial, t: start, start };
    setForm(values);
    void run(values).catch((error) => {
      if (active)
        setQueryError(error instanceof Error ? error.message : "Query failed.");
    });
    return () => {
      active = false;
    };
  }, [fork, target?.timestamp]);
  const selectedEdge =
    selection?.type === "edge"
      ? result?.edges.find((e) => e.id === selection.id)
      : undefined;
  const selectedNode = selection?.type === "node" ? selection.id : null;
  const field = (
    name: string,
    key: "t" | "start" | "end" | "node" | "seed",
  ) => (
    <Field label={name}>
      <input
        value={form[key]}
        onChange={(e) => update(key, e.target.value)}
        pattern={key === "node" || key === "seed" ? "[0-9]+" : "-?[0-9]+"}
        required
        inputMode="numeric"
      />
    </Field>
  );
  return (
    <>
      <Head
        title="Explore any moment."
        text="Follow relationships through time."
      >
        <button
          className="primary"
          onClick={() =>
            void action.run(
              () =>
                download("/v1/export_arrow", `chronograph-${form.t}.arrow`, {
                  t: submitted.t,
                  ...(fork ? { fork } : {}),
                }),
              "Arrow snapshot downloaded.",
            )
          }
          disabled={
            action.busy || !result || submitted.mode !== "as_of" || synthetic
          }
        >
          <Download size={17} /> Export Arrow
        </button>
      </Head>
      <div className="scope-strip">
        <span className="scope-badge">
          {fork ? `Branch ${fork}` : "Main graph"}
        </span>
        <span>
          {target?.name || "Parent timeline"}
          {fork
            ? ` · starts at ${target?.timestamp || "…"} µs`
            : " · all recorded versions"}
        </span>
      </div>
      <SubmitForm
        className="query-bar"
        onSubmit={() => void action.run(() => run())}
      >
        <Field label="Query mode">
          <select
            value={form.mode}
            onChange={(e) => update("mode", e.target.value)}
          >
            <option value="as_of">As of</option>
            <option value="between">Between</option>
            <option value="history">Full history</option>
            <option value="neighbors">Neighbors</option>
            <option value="sample">Sample neighbors</option>
          </select>
        </Field>
        {!["history", "between"].includes(form.mode) &&
          field("Timestamp (µs)", "t")}
        {form.mode === "between" && (
          <>
            {field("Start (µs)", "start")}
            {field("End (µs)", "end")}
          </>
        )}
        {["neighbors", "sample"].includes(form.mode) &&
          field("Source node", "node")}
        {form.mode === "sample" && (
          <>
            <Field label="Sample size">
              <input
                type="number"
                min="0"
                max="1000"
                value={form.k}
                onChange={(e) => update("k", Number(e.target.value))}
              />
            </Field>
            <Field label="Strategy">
              <select
                value={form.strategy}
                onChange={(e) => update("strategy", e.target.value)}
              >
                <option value="latest">Latest first</option>
                <option value="uniform" disabled={synthetic}>
                  Uniform{synthetic ? " · live workspace required" : ""}
                </option>
              </select>
            </Field>
            {field("Random seed", "seed")}
          </>
        )}
        <Field label="Page limit">
          <input
            type="number"
            min="1"
            max="1000"
            value={form.limit}
            onChange={(e) => update("limit", Number(e.target.value))}
            required
          />
        </Field>
        <button className="primary" disabled={action.busy}>
          <Play size={15} />
          <Busy busy={action.busy}>Run query</Busy>
        </button>
        <span className="interval-note">Half-open intervals [from, to)</span>
      </SubmitForm>
      {action.feedback}
      {queryError && (
        <div role="alert" className="notice error">
          {queryError}
        </div>
      )}
      <div className="explorer-grid">
        <section className="panel graph-panel">
          {result ? (
            <GraphView
              edges={result.edges}
              selection={selection}
              onSelect={setSelection}
            />
          ) : (
            <p className="loading" role="status">
              Loading graph…
            </p>
          )}
          {form.mode === "as_of" && !fork && (
            <div className="time-scrubber">
              <label htmlFor="time-slider">
                Sample time range <span>0–4 seconds · {form.t} µs</span>
              </label>
              <input
                id="time-slider"
                type="range"
                min="0"
                max="4000000"
                step="100000"
                value={Math.min(4000000, Math.max(0, Number(form.t) || 0))}
                disabled={action.busy}
                onChange={(e) => update("t", e.target.value)}
                onPointerUp={(e) => {
                  const t = e.currentTarget.value;
                  void action.run(() => run({ ...form, t }));
                }}
                onKeyUp={(e) => {
                  if (
                    [
                      "ArrowLeft",
                      "ArrowRight",
                      "Home",
                      "End",
                      "PageUp",
                      "PageDown",
                    ].includes(e.key)
                  ) {
                    const t = e.currentTarget.value;
                    void action.run(() => run({ ...form, t }));
                  }
                }}
              />
              <small>
                Release to query this sample range. Enter an exact timestamp
                above for other ranges.
              </small>
            </div>
          )}
        </section>
        <aside className="panel query-details">
          <h2>
            {selectedEdge
              ? "Selected relationship"
              : selectedNode
                ? "Selected node"
                : "Query details"}
          </h2>
          {selectedEdge && (
            <div className="selection-details">
              <span className="scope-badge">Version {selectedEdge.id}</span>
              <dl>
                {[
                  ["Source", selectedEdge.src],
                  ["Destination", selectedEdge.dst],
                  [
                    "Kind",
                    selectedEdge.relation
                      ? `${selectedEdge.relation} (${selectedEdge.kind})`
                      : String(selectedEdge.kind),
                  ],
                  ["Valid from", selectedEdge.valid_from],
                  ["Valid to", endTime(selectedEdge.valid_to)],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <p className="small">Payload · 16 bytes</p>
              <code className="payload-value">{selectedEdge.payload}</code>
              {selectedEdge.properties &&
                Object.keys(selectedEdge.properties).length > 0 && (
                  <>
                    <h3>Typed properties</h3>
                    <dl className="inspector-list">
                      {Object.entries(selectedEdge.properties).map(
                        ([name, value]) => (
                          <div key={name}>
                            <dt>{name}</dt>
                            <dd>{String(value)}</dd>
                          </div>
                        ),
                      )}
                    </dl>
                  </>
                )}
              {selectedEdge.schema_error && (
                <p className="notice error">{selectedEdge.schema_error}</p>
              )}
            </div>
          )}
          {selectedNode && (
            <div className="selection-details">
              <span className="scope-badge">Node {selectedNode}</span>
              <dl>
                <div>
                  <dt>Outgoing in page</dt>
                  <dd>
                    {result?.edges.filter((e) => e.src === selectedNode).length}
                  </dd>
                </div>
                <div>
                  <dt>Incoming in page</dt>
                  <dd>
                    {result?.edges.filter((e) => e.dst === selectedNode).length}
                  </dd>
                </div>
              </dl>
              <button
                className="outline"
                disabled={action.busy}
                onClick={() => {
                  const values = {
                    ...form,
                    mode: "neighbors",
                    node: selectedNode,
                  };
                  setForm(values);
                  void action.run(() => run(values));
                }}
              >
                Query this neighborhood
              </button>
            </div>
          )}
          {(selectedEdge || selectedNode) && <h3>Query details</h3>}
          <dl>
            <div>
              <dt>Mode</dt>
              <dd>{result ? submitted.mode.replaceAll("_", " ") : "—"}</dd>
            </div>
            <div>
              <dt>
                {submitted.mode === "between"
                  ? "Window (µs)"
                  : "Timestamp (µs)"}
              </dt>
              <dd>
                {result
                  ? submitted.mode === "between"
                    ? `${submitted.start} → ${submitted.end}`
                    : submitted.mode === "history"
                      ? "All time"
                      : submitted.t
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Result page</dt>
              <dd>{result ? `${result.count} relationships` : "—"}</dd>
            </div>
            <div>
              <dt>Engine + lock wait</dt>
              <dd>
                {result?.duration_ms != null
                  ? `${result.duration_ms.toFixed(3)} ms`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>More results</dt>
              <dd>{result?.next_cursor != null ? "Yes" : "No"}</dd>
            </div>
          </dl>
          <h3>Time is part of the data.</h3>
          <p>
            Relationships are active from their inclusive start until their
            exclusive end. Open intervals persist until a later version or an
            invalidation.
          </p>
          <p className="small">
            Timings include engine lock wait and result construction, and
            exclude HTTP transport. Pagination stops if the graph changes.
          </p>
        </aside>
      </div>
      <section className="panel relationships">
        <div className="section-head">
          <h2>Relationships</h2>
          <span className="mono">{result?.count ?? 0} in this page</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "ID",
                  "Source",
                  "Target",
                  "Kind",
                  "Valid from",
                  "Valid to",
                  "Payload",
                ].map((x) => (
                  <th key={x}>{x}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result?.edges.map((e) => (
                <tr
                  key={e.id}
                  className={selectedEdge?.id === e.id ? "selected-row" : ""}
                >
                  <td>
                    <button
                      className="ghost table-id"
                      aria-label={`Inspect version ${e.id}`}
                      onClick={() => setSelection({ type: "edge", id: e.id })}
                    >
                      {e.id}
                    </button>
                  </td>
                  <td>{e.src}</td>
                  <td>{e.dst}</td>
                  <td title={`Kind ${e.kind}`}>{e.relation || e.kind}</td>
                  <td>{e.valid_from}</td>
                  <td>{endTime(e.valid_to)}</td>
                  <td title={e.payload}>{e.payload}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result?.count === 0 && (
            <p className="empty-table">No matching relationships.</p>
          )}
        </div>
        <div className="pagination">
          <button
            className="outline"
            disabled={cursor === null || action.busy}
            onClick={() => void action.run(() => run(submitted, null))}
          >
            First page
          </button>
          <span className="small">
            {cursor ? "Continuation page" : "First page"}
          </span>
          <button
            className="outline"
            disabled={result?.next_cursor == null || action.busy}
            onClick={() =>
              void action.run(() => run(submitted, result!.next_cursor!))
            }
          >
            Next page
          </button>
        </div>
      </section>
    </>
  );
}
