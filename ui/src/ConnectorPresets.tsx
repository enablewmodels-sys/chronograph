import { useEffect, useState } from "react";
import { graph } from "./api";
import { Field, Busy } from "./shared";
import { useSchema } from "./schema-store";
import { useAuth } from "./main";

export type ConnectorDefinition = {
  id: string;
  family: string;
  name: string;
  presets: string[];
  contract_version: number;
  transport: string;
  native_import: string;
  description: string;
  upstream: string;
};
export type Binding = {
  id: string;
  connector: string;
  preset: string;
  contract_version: number;
  kind: number;
  clock_domain: string;
  modalities: string[];
  channels: string[];
  units: string[];
  topics: string[];
  tensor_shapes: Record<string, number[]>;
  secret_refs: string[];
};
export default function ConnectorPresets({
  onGenerate,
  disabled = false,
}: {
  onGenerate: (source: string) => void;
  disabled?: boolean;
}) {
  const { connection } = useAuth();
  const { catalog } = useSchema();
  const [definitions, setDefinitions] = useState<ConnectorDefinition[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [family, setFamily] = useState("JEPA");
  const [connector, setConnector] = useState("");
  const [preset, setPreset] = useState("");
  const [instance, setInstance] = useState("my_model");
  const [kind, setKind] = useState(100);
  const [clock, setClock] = useState("unix_us");
  const [modalities, setModalities] = useState("");
  const [channels, setChannels] = useState("");
  const [units, setUnits] = useState("");
  const [topics, setTopics] = useState("");
  const [shapes, setShapes] = useState("{}");
  const synthetic = connection?.edition === "synthetic";
  useEffect(() => {
    if (synthetic) return;
    let active = true;
    graph<{ connectors: ConnectorDefinition[] }>("connector_catalog")
      .then((r) => {
        if (active) setDefinitions(r.connectors);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [synthetic]);
  const families = [...new Set(definitions.map((d) => d.family))];
  const matches = definitions.filter(
    (d) =>
      d.family === family &&
      `${d.name} ${d.presets.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const selected = matches.find((d) => d.id === connector) ?? matches[0];
  const selectedPreset = selected?.presets.includes(preset)
    ? preset
    : (selected?.presets[0] ?? "");
  const split = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  async function generate() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      if (catalog?.relations.some((r) => r.kind === kind))
        throw new Error(
          "This kind already has a relation. Choose an unused kind.",
        );
      const result = await graph<{ source: string }>("connector_template", {
        id: instance,
        connector: selected.id,
        preset: selectedPreset,
        contract_version: selected.contract_version,
        kind,
        clock_domain: clock,
        modalities: split(modalities),
        channels: split(channels),
        units: split(units),
        topics: split(topics),
        tensor_shapes: JSON.parse(shapes),
        secret_refs: [],
      });
      onGenerate(result.source);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not generate migration.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connector-presets">
      <div className="section-head">
        <h3>Start from a connector</h3>
        <span className="scope-badge">Contract v1</span>
      </div>
      <p>
        Choose your data source. Preview the generated relations and
        configuration before applying.
      </p>
      {synthetic ? (
        <p className="notice">
          Connect a workspace to load its supported presets.
        </p>
      ) : (
        <>
          <div className="fields two">
            <Field label="Family">
              <select
                aria-label="Family"
                value={family}
                onChange={(e) => {
                  setFamily(e.target.value);
                  setQuery("");
                  setConnector("");
                  setPreset("");
                }}
              >
                {families.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Field>
            <Field label="Search connectors">
              <input
                aria-label="Search connectors"
                value={query}
                placeholder="Model or connector name"
                onChange={(e) => setQuery(e.target.value)}
              />
            </Field>
            <Field label="Connector / model">
              <select
                aria-label="Connector / model"
                value={selected?.id ?? ""}
                onChange={(e) => {
                  setConnector(e.target.value);
                  setPreset("");
                }}
              >
                <option value="" disabled>
                  Select a connector
                </option>
                {matches.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Version / preset">
              <select
                aria-label="Version / preset"
                value={selectedPreset}
                onChange={(e) => setPreset(e.target.value)}
              >
                {selected?.presets.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </Field>
          </div>
          {selected ? (
            <div className="notice informational">
              <p>{selected.description}</p>
              <small>
                Transport: normalized records · Native import:{" "}
                {selected.native_import.replaceAll("_", " ")}
              </small>
            </div>
          ) : (
            <p>No matching connectors in this family.</p>
          )}
          <fieldset disabled={disabled || busy}>
            <div className="fields two">
              <Field label="Instance name">
                <input
                  aria-label="Instance name"
                  value={instance}
                  maxLength={48}
                  onChange={(e) => setInstance(e.target.value)}
                />
              </Field>
              <Field label="Relation kind">
                <input
                  aria-label="Relation kind"
                  type="number"
                  min={0}
                  max={65535}
                  value={kind}
                  onChange={(e) => setKind(Number(e.target.value))}
                />
              </Field>
              <Field label="Source clock">
                <select
                  aria-label="Source clock"
                  value={clock}
                  onChange={(e) => setClock(e.target.value)}
                >
                  {[
                    "unix_us",
                    "simulation_us",
                    "lsl_local_us",
                    "device_us",
                  ].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </Field>
              <Field label="Modalities (comma separated)">
                <input
                  aria-label="Modalities (comma separated)"
                  value={modalities}
                  placeholder="latent, image, action"
                  onChange={(e) => setModalities(e.target.value)}
                />
              </Field>
            </div>
            <details>
              <summary>Channels, topics and tensor shapes</summary>
              <div className="fields two">
                <Field label="Channels (comma separated)">
                  <input
                    aria-label="Channels (comma separated)"
                    value={channels}
                    placeholder="C3, C4"
                    onChange={(e) => setChannels(e.target.value)}
                  />
                </Field>
                <Field label="Units (one per channel)">
                  <input
                    aria-label="Units (one per channel)"
                    value={units}
                    placeholder="uV, uV"
                    onChange={(e) => setUnits(e.target.value)}
                  />
                </Field>
                <Field label="ROS topics (comma separated)">
                  <input
                    aria-label="ROS topics (comma separated)"
                    value={topics}
                    placeholder="/joint_states"
                    onChange={(e) => setTopics(e.target.value)}
                  />
                </Field>
                <Field label="Tensor shapes (JSON)">
                  <textarea
                    aria-label="Tensor shapes (JSON)"
                    value={shapes}
                    spellCheck={false}
                    onChange={(e) => setShapes(e.target.value)}
                    placeholder={'{"latent":[1,1024]}'}
                  />
                </Field>
              </div>
            </details>
            <button
              type="button"
              className="primary"
              disabled={!selected || busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <Busy busy={busy}>Working</Busy>
              ) : (
                "Generate connector migration"
              )}
            </button>
          </fieldset>
        </>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </div>
  );
}
