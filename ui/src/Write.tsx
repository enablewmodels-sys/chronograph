import { useEffect, useRef, useState } from "react";
import { graph } from "./api";
import { useSchema } from "./schema-store";
import { useWorkspace, workspaceChanged } from "./workspace";
import { Busy, Field, Head, SubmitForm, useAction } from "./shared";
const sample = JSON.stringify(
  [
    {
      src: "1001",
      dst: "1002",
      kind: 1,
      valid_from: "5000000",
      payload: "00".repeat(16),
    },
  ],
  null,
  2,
);
export default function Write() {
  const { catalog, error: schemaError } = useSchema();
  const [format, setFormat] = useState("hex");
  const [values, setValues] = useState<Record<string, string>>({});
  const { fork, forks } = useWorkspace();
  const target = forks.find((f) => f.id === fork);
  const currentFork = useRef(fork);
  currentFork.current = fork;
  const action = useAction(),
    [result, setResult] = useState<unknown>(null),
    [input, setInput] = useState({
      src: "",
      dst: "",
      kind: 1,
      valid_from: "",
      valid_to: "",
      payload: "00".repeat(16),
    }),
    [batch, setBatch] = useState(sample),
    [node, setNode] = useState(""),
    [id, setId] = useState(""),
    [time, setTime] = useState(""),
    [lookup, setLookup] = useState("");
  const definition = catalog?.relations.find((r) => r.kind === input.kind);
  const typed = format === "properties" && !!definition?.properties.length;
  useEffect(() => {
    setResult(null);
  }, [fork]);
  const scoped = (args: object) => ({ ...args, ...(fork ? { fork } : {}) });
  const perform = async (op: string, args: object) => {
    const result = await graph(op, scoped(args));
    if (currentFork.current === fork) setResult(result);
    if (["add_edges", "add_node", "invalidate_edge"].includes(op))
      workspaceChanged();
  };
  const execute = (op: string, args: object) =>
    void action.run(() => perform(op, args), "Operation completed.");
  return (
    <>
      <Head
        title="Write a changing world."
        text="Durable mutations. Preserved history. Exact microsecond timestamps."
      />
      <div className="scope-strip">
        <span className="scope-badge">
          {fork ? `Branch ${fork}` : "Main graph"}
        </span>
        <span>
          {target?.name || (fork ? "Selected branch" : "Writing to main")} ·
          disk sync on every write
        </span>
      </div>
      {fork && target?.status !== "active" && (
        <div className="notice error">
          This branch is closed or unavailable. Select an active branch or Main
          before writing.
        </div>
      )}
      {action.feedback}
      {schemaError && (
        <div className="notice error">Schema unavailable: {schemaError}</div>
      )}
      <div className="form-grid">
        <section className="panel form-panel">
          <h2>Insert a relationship</h2>
          <p>
            Missing endpoints are created automatically. A later version
            shortens its predecessor.
          </p>
          <SubmitForm
            onSubmit={() => {
              const { valid_to, payload, ...edge } = input;
              const properties = typed
                ? Object.fromEntries(
                    definition!.properties.map((p) => [
                      p.name,
                      p.type === "bool"
                        ? values[p.name] === "true"
                        : p.type === "u64" || p.type === "i64"
                          ? values[p.name]
                          : Number(values[p.name]),
                    ]),
                  )
                : undefined;
              execute("add_edges", {
                edges: [
                  {
                    ...edge,
                    ...(valid_to ? { valid_to } : {}),
                    ...(typed ? { properties } : { payload }),
                  },
                ],
              });
            }}
          >
            {!!catalog?.relations.length && (
              <Field label="Schema relation">
                <select
                  value={definition?.kind ?? ""}
                  onChange={(e) => {
                    if (e.target.value !== "") {
                      const kind = Number(e.target.value);
                      setInput({ ...input, kind });
                      setValues({});
                      setFormat("properties");
                    }
                  }}
                >
                  <option value="">Custom numeric kind</option>
                  {catalog.relations.map((r) => (
                    <option key={r.kind} value={r.kind}>
                      {r.name} · {r.source_label} → {r.target_label} · kind{" "}
                      {r.kind}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="fields two">
              {(["src", "dst", "valid_from", "valid_to"] as const).map(
                (key) => (
                  <Field
                    key={key}
                    label={
                      {
                        src: "Source ID",
                        dst: "Target ID",
                        valid_from: "Valid from (µs)",
                        valid_to: "Valid to (µs, optional)",
                      }[key]
                    }
                  >
                    <input
                      required={key !== "valid_to"}
                      inputMode="numeric"
                      placeholder={
                        key === "valid_to" ? "Open-ended" : undefined
                      }
                      pattern={key.startsWith("valid_") ? "-?[0-9]+" : "[0-9]+"}
                      value={input[key]}
                      onChange={(e) =>
                        setInput({ ...input, [key]: e.target.value })
                      }
                    />
                  </Field>
                ),
              )}
              <Field label="Relationship kind">
                <input
                  type="number"
                  min="0"
                  max="65535"
                  required
                  value={input.kind}
                  onChange={(e) =>
                    setInput({ ...input, kind: Number(e.target.value) })
                  }
                />
              </Field>
            </div>
            {!!definition?.properties.length && (
              <Field label="Payload format">
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                >
                  <option value="properties">Structured properties</option>
                  <option value="hex">Hex payload</option>
                </select>
              </Field>
            )}
            {typed ? (
              <div className="typed-properties">
                <h3>{definition!.name} properties</h3>
                {definition!.properties.map((p) => (
                  <Field key={p.name} label={`${p.name} (${p.type})`}>
                    {p.type === "bool" ? (
                      <select
                        value={values[p.name] || "false"}
                        onChange={(e) =>
                          setValues({ ...values, [p.name]: e.target.value })
                        }
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : (
                      <input
                        required
                        type={
                          p.type === "u64" || p.type === "i64"
                            ? "text"
                            : "number"
                        }
                        step={
                          p.type === "f32" || p.type === "f64" ? "any" : "1"
                        }
                        pattern={
                          p.type === "u64"
                            ? "[0-9]+"
                            : p.type === "i64"
                              ? "-?[0-9]+"
                              : undefined
                        }
                        value={values[p.name] ?? ""}
                        onChange={(e) =>
                          setValues({ ...values, [p.name]: e.target.value })
                        }
                      />
                    )}
                  </Field>
                ))}
                <p className="small muted">
                  The service validates and packs these values into the 16-byte
                  payload.
                </p>
              </div>
            ) : (
              <Field label="Payload (16 bytes, hex)">
                <input
                  className="mono"
                  pattern="[0-9a-fA-F]{32}"
                  required
                  value={input.payload}
                  onChange={(e) =>
                    setInput({ ...input, payload: e.target.value })
                  }
                />
              </Field>
            )}
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Insert relationship</Busy>
            </button>
          </SubmitForm>
        </section>
        <section className="panel form-panel">
          <h2>Atomic batch</h2>
          <p>
            Submit 1–10,000 versions together. IDs and timestamps must be quoted
            decimal strings.
          </p>
          <SubmitForm
            onSubmit={() =>
              void action.run(async () => {
                const edges: unknown = JSON.parse(batch);
                if (!Array.isArray(edges))
                  throw new Error("Batch must be a JSON array.");
                await perform("add_edges", { edges });
              }, "Batch committed atomically.")
            }
          >
            <Field label="Batch JSON">
              <textarea
                rows={12}
                className="mono"
                value={batch}
                onChange={(e) => setBatch(e.target.value)}
                required
                spellCheck={false}
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Commit batch</Busy>
            </button>
          </SubmitForm>
        </section>
        <section className="panel form-panel">
          <h2>Register a node</h2>
          <p>Create an isolated node. Repeated registration is a no-op.</p>
          <SubmitForm onSubmit={() => execute("add_node", { id: node })}>
            <Field label="Node ID">
              <input
                required
                pattern="[0-9]+"
                value={node}
                onChange={(e) => setNode(e.target.value)}
              />
            </Field>
            <button className="outline" disabled={action.busy}>
              Register node
            </button>
          </SubmitForm>
          <SubmitForm
            className="lookup-form"
            onSubmit={() => execute("contains_node", { id: lookup })}
          >
            <Field label="Look up node ID">
              <input
                required
                pattern="[0-9]+"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
            </Field>
            <button className="outline" disabled={action.busy}>
              Check node
            </button>
          </SubmitForm>
        </section>
        <section className="panel form-panel">
          <h2>Invalidate a version</h2>
          <p>
            Shorten validity at a specified time. The original version remains
            in history.
          </p>
          <SubmitForm
            onSubmit={() => {
              if (
                window.confirm(
                  `Shorten edge ${id} in ${fork ? `branch ${fork}` : "main"} at ${time} µs? This cannot be undone.`,
                )
              )
                execute("invalidate_edge", { id, t: time });
            }}
          >
            <div className="fields two">
              <Field label="Edge version ID">
                <input
                  required
                  pattern="[0-9]+"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                />
              </Field>
              <Field label="Invalidate at (µs)">
                <input
                  required
                  pattern="-?[0-9]+"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                />
              </Field>
            </div>
            <button className="outline danger" disabled={action.busy}>
              Invalidate version
            </button>
            <button
              type="button"
              className="ghost"
              disabled={!id || action.busy}
              onClick={() => execute("get_edge", { id })}
            >
              Inspect version first
            </button>
          </SubmitForm>
        </section>
      </div>
      {result !== null && (
        <section className="panel response">
          <h2>Operation result</h2>
          <pre aria-live="polite">{JSON.stringify(result, null, 2)}</pre>
        </section>
      )}
      <p className="small muted">
        If a write loses its connection, inspect history before retrying.
        Insertions do not use idempotency keys.
      </p>
    </>
  );
}
