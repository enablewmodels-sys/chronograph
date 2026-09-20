import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Braces,
  Check,
  Download,
  FileCode2,
  GitCommitHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Link } from "react-router-dom";
import { graph } from "./api";
import { useAuth } from "./main";
import { Busy, Field, Head, SubmitForm, useAction } from "./shared";
import {
  migrationSource,
  migrationSources,
  migrationBundle,
  saveJson,
  sizes,
  useSchema,
  type PropertyType,
  type Relation,
  type Settings,
  type Snapshot,
} from "./schema-store";
import "./schema.css";
import ConnectorPresets from "./ConnectorPresets";

type Preview = {
  id?: string;
  name?: string;
  schema_revision?: number;
  migrations?: {
    id: string;
    name: string;
    already_applied: boolean;
    requires: string[];
  }[];
  checksum: string;
  expected_revision: number;
  already_applied: boolean;
  before: Snapshot;
  after: Snapshot;
  operations: unknown[];
  warnings: string[];
};
const blank = (kind: number): Relation => ({
  kind,
  name: "",
  description: "",
  source_label: "node",
  target_label: "node",
  properties: [],
});
const template = () =>
  migrationSource(
    [
      {
        op: "upsert_relation",
        relation: {
          kind: 10,
          name: "observes",
          description: "Confidence and observation sequence",
          source_label: "sensor",
          target_label: "object",
          properties: [
            { name: "confidence", type: "f32", offset: 0 },
            { name: "sequence", type: "u64", offset: 8 },
          ],
        },
      },
    ],
    "Define observations",
  );

export default function Schema() {
  const { connection } = useAuth();
  const { catalog, error, refresh } = useSchema();
  const admin = connection?.credential.scope === "admin";
  const synthetic = connection?.edition === "synthetic";
  const action = useAction();
  const [tab, setTab] = useState<"Relations" | "Migrations" | "Settings">(
    "Relations",
  );
  const [relation, setRelation] = useState<Relation>(blank(10));
  const [existingKind, setExistingKind] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const draftKey = `chronograph-schema-draft:${connection?.project?.id || "community"}:${connection?.credential.id}`;
  const [source, setSource] = useState(() => {
    try {
      return sessionStorage.getItem(draftKey) || template();
    } catch {
      return template();
    }
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewSource, setPreviewSource] = useState("");
  const [viewing, setViewing] = useState("");
  const [rollbackRevision, setRollbackRevision] = useState("0");
  const editor = useRef<HTMLTextAreaElement>(null);
  const savedDraft = useRef(source);
  useEffect(() => {
    if (catalog)
      setSettings({
        ...catalog.settings,
        ...(connection?.require_fsync
          ? { default_durability: "fsync" as const }
          : {}),
      });
  }, [catalog, connection?.require_fsync]);
  useEffect(() => {
    try {
      if (admin && !viewing) {
        savedDraft.current = source;
        sessionStorage.setItem(draftKey, source);
      }
    } catch {
      /* Draft remains in memory if browser storage is unavailable. */
    }
  }, [source, draftKey, admin, viewing]);
  const draft = (operations: unknown[], name: string) => {
    setSource(migrationSource(operations, name));
    setPreview(null);
    setViewing("");
    setTab("Migrations");
  };
  const newRelation = () => {
    const used = new Set(catalog?.relations.map((r) => r.kind));
    let kind = 1;
    while (used.has(kind)) kind++;
    setRelation(blank(kind));
    setExistingKind(null);
    setEditing(true);
  };
  const previewValid =
    preview &&
    previewSource === source &&
    preview.expected_revision === catalog?.revision &&
    !viewing;
  const changeSource = (value: string) => {
    setSource(value);
    setPreview(null);
    setViewing("");
  };
  const changes = preview
    ? [
        ...preview.after.relations
          .filter(
            (r) => !preview.before.relations.some((b) => b.kind === r.kind),
          )
          .map((r) => `Add ${r.name} · kind ${r.kind}`),
        ...preview.after.relations
          .filter((r) =>
            preview.before.relations.some(
              (b) =>
                b.kind === r.kind && JSON.stringify(b) !== JSON.stringify(r),
            ),
          )
          .map((r) => `Update ${r.name} · kind ${r.kind}`),
        ...preview.before.relations
          .filter(
            (r) => !preview.after.relations.some((a) => a.kind === r.kind),
          )
          .map((r) => `Drop ${r.name} · kind ${r.kind}`),
        ...(preview.after.connectors || [])
          .filter(
            (b) =>
              !(preview.before.connectors || []).some((old) => old.id === b.id),
          )
          .map((b) => `Bind connector ${b.id} · kind ${b.kind}`),
        ...(preview.before.connectors || [])
          .filter(
            (b) =>
              !(preview.after.connectors || []).some(
                (next) => next.id === b.id,
              ),
          )
          .map((b) => `Unbind connector ${b.id}`),
        ...(Object.keys(preview.after.settings) as (keyof Settings)[])
          .filter(
            (k) => preview.before.settings[k] !== preview.after.settings[k],
          )
          .map(
            (k) =>
              `${k}: ${String(preview.before.settings[k])} → ${String(preview.after.settings[k])}`,
          ),
      ]
    : [];
  return (
    <>
      <Head
        title="Give your graph a language."
        text="Define relationships, map their properties and evolve your workspace through migrations."
      >
        <button
          className="outline"
          disabled={synthetic || action.busy || !catalog}
          onClick={() =>
            void action.run(async () => {
              const identity = JSON.parse(
                migrationSource([], "Schema baseline"),
              );
              const result = await graph<{ sources: string[] }>(
                "schema_export",
                { id: identity.id, name: identity.name },
              );
              saveJson(migrationBundle(result.sources), "schema-baseline.json");
            })
          }
        >
          <Download size={15} /> Export schema
        </button>
        <button
          className="outline"
          disabled={action.busy}
          onClick={() => void action.run(refresh)}
        >
          <RefreshCw size={15} /> Refresh schema
        </button>
      </Head>
      <div className="scope-strip">
        <span className="scope-badge">Workspace schema</span>
        <span>
          Shared by main and every branch · revision {catalog?.revision ?? "…"}
        </span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {action.feedback}
      {!admin && (
        <div className="notice">
          {synthetic
            ? "Connect a real workspace to manage its schema."
            : "Read-only access. An admin token is required to author and apply migrations."}
        </div>
      )}
      <div className="schema-tabs" role="tablist" aria-label="Schema workspace">
        {(["Relations", "Migrations", "Settings"] as const).map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            id={`tab-${name}`}
            aria-controls="schema-content"
            onClick={() => setTab(name)}
          >
            {name}
            {name === "Relations" && catalog && (
              <span>{catalog.relations.length}</span>
            )}
            {name === "Migrations" && catalog && (
              <span>{catalog.history.length}</span>
            )}
          </button>
        ))}
      </div>
      {!catalog ? (
        <p role="status">
          {error
            ? "Schema unavailable. Use Refresh schema to retry."
            : "Loading schema…"}
        </p>
      ) : (
        <div id="schema-content" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === "Relations" && (
            <>
              <div className="schema-toolbar">
                <Field label="Find a relation">
                  <input
                    placeholder="Name, kind or endpoint label"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </Field>
                <button
                  className="primary"
                  disabled={
                    !admin || action.busy || catalog.relations.length >= 1024
                  }
                  onClick={newRelation}
                >
                  <Plus size={16} /> New relation
                </button>
              </div>
              <div className={`schema-layout ${editing ? "with-editor" : ""}`}>
                <div className="schema-catalog">
                  {catalog.relations.length === 0 && (
                    <div className="panel schema-empty">
                      <Braces size={32} />
                      <h2>A schema for your world.</h2>
                      <p>
                        Give numeric relation kinds a name. Describe their
                        endpoints and turn 16 bytes into readable, typed
                        properties.
                      </p>
                      <button
                        className="outline"
                        disabled={!admin}
                        onClick={newRelation}
                      >
                        Define your first relation
                      </button>
                      <button
                        className="ghost"
                        onClick={() => {
                          if (admin) {
                            changeSource(template());
                          }
                          setTab("Migrations");
                        }}
                      >
                        Open migration editor <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                  {catalog.relations
                    .filter((r) =>
                      `${r.name} ${r.kind} ${r.source_label} ${r.target_label}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((r) => (
                      <article
                        className={`panel schema-relation ${editing && relation.kind === r.kind ? "selected" : ""}`}
                        key={r.kind}
                      >
                        <div className="schema-card-head">
                          <div>
                            <span className="eyebrow">KIND {r.kind}</span>
                            <h2>{r.name}</h2>
                          </div>
                          <button
                            className="ghost"
                            onClick={() => {
                              setRelation(structuredClone(r));
                              setExistingKind(r.kind);
                              setEditing(true);
                            }}
                          >
                            {admin ? "Edit definition" : "View definition"}
                          </button>
                        </div>
                        <div
                          className="schema-connection"
                          aria-label={`${r.source_label} to ${r.target_label}`}
                        >
                          <span>{r.source_label}</span>
                          <div>
                            <i />
                            <ArrowRight size={18} />
                          </div>
                          <span>{r.target_label}</span>
                        </div>
                        {r.description && <p>{r.description}</p>}
                        <div className="schema-property-list">
                          {r.properties.length ? (
                            r.properties.map((p) => (
                              <div key={p.name}>
                                <span className="mono">{p.name}</span>
                                <code>{p.type}</code>
                                <small>byte {p.offset}</small>
                              </div>
                            ))
                          ) : (
                            <p className="muted small">
                              Opaque payload · no typed properties
                            </p>
                          )}
                        </div>
                        <footer>
                          <span>{r.properties.length} properties</span>
                          <span>
                            {r.properties.reduce(
                              (n, p) => n + sizes[p.type],
                              0,
                            )}{" "}
                            / 16 bytes mapped
                          </span>
                        </footer>
                      </article>
                    ))}
                  {catalog.relations.length > 0 &&
                    !catalog.relations.some((r) =>
                      `${r.name} ${r.kind} ${r.source_label} ${r.target_label}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    ) && (
                      <p className="muted">No relations match your search.</p>
                    )}
                </div>
                {editing && (
                  <section className="panel form-panel schema-designer">
                    <div className="schema-card-head">
                      <h2>
                        {catalog.relations.some((r) => r.kind === relation.kind)
                          ? "Relation definition"
                          : "New relation"}
                      </h2>
                      <button
                        className="ghost"
                        onClick={() => setEditing(false)}
                      >
                        Close
                      </button>
                    </div>
                    <p>
                      Changes become a migration for review before applying.
                    </p>
                    <SubmitForm
                      onSubmit={() =>
                        draft(
                          [{ op: "upsert_relation", relation }],
                          `Define ${relation.name}`,
                        )
                      }
                    >
                      <fieldset
                        disabled={
                          !admin ||
                          action.busy ||
                          relation.payload_encoding === "arrow_record_v1"
                        }
                      >
                        <div className="fields two">
                          <Field label="Relation name">
                            <input
                              required
                              pattern="[A-Za-z_][A-Za-z0-9_]*"
                              maxLength={64}
                              placeholder="observes"
                              value={relation.name}
                              onChange={(e) =>
                                setRelation({
                                  ...relation,
                                  name: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="Kind ID">
                            <input
                              type="number"
                              required
                              min={0}
                              max={65535}
                              value={relation.kind}
                              disabled={existingKind !== null}
                              onChange={(e) =>
                                setRelation({
                                  ...relation,
                                  kind: Number(e.target.value),
                                })
                              }
                            />
                          </Field>
                        </div>
                        <Field label="Relation description">
                          <textarea
                            rows={2}
                            maxLength={2000}
                            value={relation.description}
                            onChange={(e) =>
                              setRelation({
                                ...relation,
                                description: e.target.value,
                              })
                            }
                          />
                        </Field>
                        <div className="fields two">
                          <Field label="Source label">
                            <input
                              required
                              pattern="[A-Za-z_][A-Za-z0-9_]*"
                              maxLength={64}
                              value={relation.source_label}
                              onChange={(e) =>
                                setRelation({
                                  ...relation,
                                  source_label: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="Target label">
                            <input
                              required
                              pattern="[A-Za-z_][A-Za-z0-9_]*"
                              maxLength={64}
                              value={relation.target_label}
                              onChange={(e) =>
                                setRelation({
                                  ...relation,
                                  target_label: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </div>
                        <p className="small muted">
                          Endpoint labels document your model. Node IDs do not
                          carry enforced type tags.
                        </p>
                        <div className="schema-card-head">
                          <h3>Payload properties</h3>
                          <button
                            type="button"
                            className="ghost"
                            disabled={relation.properties.length >= 16}
                            onClick={() => {
                              const offset = Math.max(
                                0,
                                ...relation.properties.map(
                                  (p) => p.offset + sizes[p.type],
                                ),
                              );
                              setRelation({
                                ...relation,
                                properties: [
                                  ...relation.properties,
                                  {
                                    name: "",
                                    type: offset <= 12 ? "f32" : "bool",
                                    offset: Math.min(offset, 15),
                                  },
                                ],
                              });
                            }}
                          >
                            <Plus size={14} /> Add property
                          </button>
                        </div>
                        {relation.properties.map((p, i) => (
                          <div className="schema-property-form" key={i}>
                            <Field label={`Property ${i + 1} name`}>
                              <input
                                required
                                pattern="[A-Za-z_][A-Za-z0-9_]*"
                                maxLength={64}
                                placeholder="confidence"
                                value={p.name}
                                onChange={(e) =>
                                  setRelation({
                                    ...relation,
                                    properties: relation.properties.map(
                                      (v, j) =>
                                        j === i
                                          ? { ...v, name: e.target.value }
                                          : v,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <Field label={`Property ${i + 1} type`}>
                              <select
                                value={p.type}
                                onChange={(e) =>
                                  setRelation({
                                    ...relation,
                                    properties: relation.properties.map(
                                      (v, j) =>
                                        j === i
                                          ? {
                                              ...v,
                                              type: e.target
                                                .value as PropertyType,
                                            }
                                          : v,
                                    ),
                                  })
                                }
                              >
                                {Object.keys(sizes).map((t) => (
                                  <option key={t}>{t}</option>
                                ))}
                              </select>
                            </Field>
                            <Field label={`Property ${i + 1} offset`}>
                              <input
                                type="number"
                                required
                                min={0}
                                max={16 - sizes[p.type]}
                                value={p.offset}
                                onChange={(e) =>
                                  setRelation({
                                    ...relation,
                                    properties: relation.properties.map(
                                      (v, j) =>
                                        j === i
                                          ? {
                                              ...v,
                                              offset: Number(e.target.value),
                                            }
                                          : v,
                                    ),
                                  })
                                }
                              />
                            </Field>
                            <button
                              type="button"
                              className="ghost"
                              aria-label={`Remove property ${i + 1}`}
                              onClick={() =>
                                setRelation({
                                  ...relation,
                                  properties: relation.properties.filter(
                                    (_, j) => j !== i,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ))}
                        <div
                          className="schema-bytes"
                          aria-label="16-byte payload layout"
                        >
                          {Array.from({ length: 16 }, (_, i) => (
                            <span
                              key={i}
                              className={
                                relation.properties.some(
                                  (p) =>
                                    i >= p.offset &&
                                    i < p.offset + sizes[p.type],
                                )
                                  ? "used"
                                  : ""
                              }
                              title={`Byte ${i}`}
                            >
                              {i}
                            </span>
                          ))}
                        </div>
                        <p className="small muted">
                          Little-endian encoding. Layout changes and drops are
                          blocked when the kind has stored versions in main or
                          an active branch.
                        </p>
                        <button className="primary">
                          <FileCode2 size={16} /> Create migration
                        </button>
                        {catalog.relations.some(
                          (r) => r.kind === relation.kind,
                        ) && (
                          <button
                            type="button"
                            className="ghost danger"
                            onClick={() =>
                              draft(
                                [{ op: "drop_relation", kind: relation.kind }],
                                `Drop ${relation.name}`,
                              )
                            }
                          >
                            Draft removal
                          </button>
                        )}
                      </fieldset>
                    </SubmitForm>
                  </section>
                )}
              </div>
            </>
          )}
          {tab === "Migrations" && (
            <div className="schema-migrations">
              <section className="panel schema-editor">
                <div className="schema-editor-head">
                  <div>
                    <span className="eyebrow">
                      CHRONOGRAPH JSON · V1 / V2 / V3
                    </span>
                    <h2>
                      {viewing ? "Applied migration" : "Migration editor"}
                    </h2>
                  </div>
                  <div className="schema-actions">
                    <button
                      className="ghost"
                      disabled={!admin || action.busy}
                      onClick={() => {
                        changeSource(template());
                        editor.current?.focus();
                      }}
                    >
                      <Plus size={15} /> Template
                    </button>
                    <label
                      className={`outline schema-upload ${!admin || action.busy ? "disabled" : ""}`}
                    >
                      <Upload size={15} /> Import files
                      <input
                        aria-label="Import migration file"
                        type="file"
                        multiple
                        accept=".json,application/json"
                        disabled={!admin || action.busy}
                        onChange={(e) => {
                          const files = Array.from(e.target.files || []).sort(
                            (a, b) =>
                              a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
                          );
                          e.target.value = "";
                          if (files.length)
                            void action.run(async () => {
                              if (
                                files.length > 64 ||
                                files.reduce((n, f) => n + f.size, 0) > 1048576
                              )
                                throw new Error(
                                  "Import at most 64 files within 1 MiB total.",
                                );
                              const sources = (
                                await Promise.all(
                                  files.map(async (file) =>
                                    migrationSources(await file.text()),
                                  ),
                                )
                              ).flat();
                              const bundle = migrationBundle(sources);
                              migrationSources(bundle);
                              changeSource(bundle);
                            });
                        }}
                      />
                    </label>
                    <button
                      className="ghost"
                      disabled={!source}
                      onClick={() =>
                        saveJson(source, `${viewing || "migration"}.json`)
                      }
                    >
                      <Download size={15} /> Export
                    </button>
                  </div>
                </div>
                <p>
                  Import ordered JSON files, paste a migration bundle, or use
                  the relation and settings forms. All pending files commit
                  together. Each migration is recorded once by ID and checksum.
                </p>
                {!viewing && (
                  <ConnectorPresets
                    onGenerate={changeSource}
                    disabled={!admin || action.busy}
                  />
                )}
                {viewing && (
                  <div className="notice">
                    Applied source is immutable.{" "}
                    <button
                      className="text-link"
                      disabled={!admin}
                      onClick={() => changeSource(savedDraft.current)}
                    >
                      Back to draft
                    </button>{" "}
                    ·{" "}
                    <button
                      className="text-link"
                      disabled={!admin}
                      onClick={() =>
                        void action.run(async () => {
                          const value = JSON.parse(source);
                          changeSource(
                            migrationSource(
                              value.operations,
                              `Amend ${value.name}`,
                              [value.id],
                            ),
                          );
                        })
                      }
                    >
                      Copy to a new migration
                    </button>
                  </div>
                )}
                <Field label="Migration JSON">
                  <textarea
                    ref={editor}
                    className="mono schema-code"
                    rows={Math.max(
                      12,
                      Math.min(24, source.split("\n").length + 1),
                    )}
                    spellCheck={false}
                    readOnly={!admin || !!viewing}
                    disabled={action.busy}
                    value={source}
                    onChange={(e) => changeSource(e.target.value)}
                  />
                </Field>
                <div className="schema-editor-footer">
                  <span className="small muted">
                    {source.split("\n").length} lines ·{" "}
                    {(new TextEncoder().encode(source).length / 1024).toFixed(
                      1,
                    )}{" "}
                    KiB · 1 MiB plan limit · 256 KiB per migration
                  </span>
                  <button
                    className="outline"
                    disabled={synthetic || action.busy || !source || !!viewing}
                    onClick={() =>
                      void action.run(async () => {
                        setPreview(null);
                        const sources = migrationSources(source);
                        const result = await graph<Preview>(
                          sources.length === 1
                            ? "schema_preview"
                            : "schema_plan",
                          sources.length === 1
                            ? { source: sources[0] }
                            : { sources },
                        );
                        setPreview(result);
                        setPreviewSource(source);
                      })
                    }
                  >
                    <Busy busy={action.busy}>Preview migration</Busy>
                  </button>
                </div>
                {preview && (
                  <section
                    className="schema-preview"
                    aria-label="Migration preview"
                  >
                    <div className="schema-card-head">
                      <h3>
                        <Check size={18} />{" "}
                        {preview.already_applied
                          ? "Already applied"
                          : "Ready for review"}
                      </h3>
                      <span className="scope-badge">
                        Revision {preview.expected_revision} →{" "}
                        {preview.schema_revision ??
                          preview.expected_revision +
                            (preview.already_applied ? 0 : 1)}
                      </span>
                    </div>
                    {preview.migrations && (
                      <ol aria-label="Ordered migration plan">
                        {preview.migrations.map((m) => (
                          <li key={m.id}>
                            <strong>{m.name}</strong> ·{" "}
                            {m.already_applied ? "Already applied" : "Pending"}
                            <div className="small muted">
                              {m.id}
                              {m.requires.length > 0 &&
                                ` · requires ${m.requires.join(", ")}`}
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                    {changes.length ? (
                      <ul>
                        {changes.map((c) => (
                          <li key={c}>{c}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>No catalog changes.</p>
                    )}
                    <details>
                      <summary>Compare complete definitions</summary>
                      <div className="schema-diff">
                        <div>
                          <h4>Before</h4>
                          <pre>{JSON.stringify(preview.before, null, 2)}</pre>
                        </div>
                        <div>
                          <h4>After</h4>
                          <pre>{JSON.stringify(preview.after, null, 2)}</pre>
                        </div>
                      </div>
                    </details>
                    <p className="small muted">{preview.warnings.join(" ")}</p>
                    <p className="small mono schema-checksum">
                      SHA-256 {preview.checksum}
                    </p>
                    {!previewValid && (
                      <p className="notice">
                        The schema or draft changed. Refresh and preview again.
                      </p>
                    )}
                    <button
                      className="primary"
                      disabled={
                        !admin ||
                        action.busy ||
                        !previewValid ||
                        preview.already_applied
                      }
                      onClick={() =>
                        void action.run(async () => {
                          const sources = migrationSources(source);
                          await graph(
                            sources.length === 1
                              ? "schema_apply"
                              : "schema_apply_plan",
                            {
                              ...(sources.length === 1
                                ? { source: sources[0] }
                                : { sources }),
                              checksum: preview.checksum,
                              expected_revision: preview.expected_revision,
                            },
                          );
                          setSource(sources[sources.length - 1]);
                          setViewing(
                            preview.migrations?.[preview.migrations.length - 1]
                              ?.id ||
                              preview.id ||
                              "applied",
                          );
                          setPreview(null);
                          await refresh();
                        }, "Migration applied and synchronized to disk.")
                      }
                    >
                      <GitCommitHorizontal size={17} /> Apply migration
                    </button>
                  </section>
                )}
              </section>
              <aside className="panel schema-history">
                <div className="schema-card-head">
                  <h2>Migration history</h2>
                  <span>{catalog.history.length}</span>
                </div>
                <p className="small muted">
                  Applied in this workspace. Choose an entry to inspect or
                  export its original file.
                </p>
                {admin && catalog.history.length > 0 && (
                  <div className="schema-rollback">
                    <Field
                      label="Restore definitions from revision"
                      hint="Creates a new migration for review. Data and history remain intact; unsafe changes are rejected."
                    >
                      <select
                        value={rollbackRevision}
                        disabled={action.busy}
                        onChange={(e) => setRollbackRevision(e.target.value)}
                      >
                        <option value="0">0 · Empty schema</option>
                        {[...catalog.history]
                          .reverse()
                          .filter((h) => h.revision < catalog.revision)
                          .map((h) => (
                            <option key={h.id} value={h.revision}>
                              {h.revision} · {h.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <button
                      className="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const identity = JSON.parse(
                            migrationSource(
                              [],
                              `Restore schema revision ${rollbackRevision}`,
                            ),
                          );
                          const result = await graph<{ sources: string[] }>(
                            "schema_rollback",
                            {
                              id: identity.id,
                              name: identity.name,
                              target_revision: Number(rollbackRevision),
                            },
                          );
                          changeSource(migrationBundle(result.sources));
                          editor.current?.focus();
                        }, "Rollback drafted. Preview and review before applying.")
                      }
                    >
                      Prepare rollback
                    </button>
                  </div>
                )}
                {!catalog.history.length && (
                  <div className="schema-history-empty">
                    <GitCommitHorizontal size={24} />
                    <p>Your first migration starts the history.</p>
                  </div>
                )}
                {catalog.history.map((h) => (
                  <button
                    className={`schema-history-item ${viewing === h.id ? "selected" : ""}`}
                    key={h.id}
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        const result = await graph<{ source: string }>(
                          "schema_migration",
                          { id: h.id },
                        );
                        setSource(result.source);
                        setViewing(h.id);
                        setPreview(null);
                      })
                    }
                  >
                    <span className="schema-history-number">{h.revision}</span>
                    <span>
                      <strong>{h.name}</strong>
                      <small>{h.id}</small>
                      <small>
                        {new Date(h.applied_at * 1000).toLocaleString()} ·{" "}
                        {h.operations} operations
                      </small>
                    </span>
                    <Check size={14} />
                  </button>
                ))}
              </aside>
            </div>
          )}
          {tab === "Settings" && settings && (
            <section className="panel form-panel schema-settings">
              <h2>Database settings</h2>
              <p>
                Save settings through a migration so each change is reviewable
                and recorded.
              </p>
              <SubmitForm
                onSubmit={() =>
                  draft(
                    [{ op: "set_settings", settings }],
                    "Update database settings",
                  )
                }
              >
                <fieldset disabled={!admin || action.busy}>
                  <Field label="Workspace name">
                    <input
                      required
                      maxLength={80}
                      value={settings.name}
                      onChange={(e) =>
                        setSettings({ ...settings, name: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Workspace description">
                    <textarea
                      maxLength={2000}
                      rows={3}
                      value={settings.description}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          description: e.target.value,
                        })
                      }
                    />
                  </Field>
                  <div className="fields two">
                    <Field
                      label="Default write durability"
                      hint={
                        connection?.require_fsync
                          ? "This deployment requires fsync. Migrations cannot weaken the server durability policy."
                          : "Used by HTTP/MCP writes that omit durability. Console writes explicitly use fsync."
                      }
                    >
                      <select
                        value={settings.default_durability}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            default_durability: e.target
                              .value as Settings["default_durability"],
                          })
                        }
                      >
                        <option
                          value="buffered"
                          disabled={connection?.require_fsync}
                        >
                          Buffered acknowledgment
                        </option>
                        <option value="fsync">
                          Fsync · synchronized to disk
                        </option>
                      </select>
                    </Field>
                    <Field
                      label="Default query page size"
                      hint="Used when an HTTP/MCP query omits its limit. Explicit limits take precedence."
                    >
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        required
                        value={settings.default_query_limit}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            default_query_limit: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  </div>
                  <label className="schema-toggle">
                    <input
                      type="checkbox"
                      checked={settings.strict_relations}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          strict_relations: e.target.checked,
                        })
                      }
                    />
                    <span>
                      <strong>Require defined relation kinds</strong>
                      <small>
                        Reject undefined kinds in service writes and merges. All
                        kinds in main and active branches must be defined before
                        enabling this.
                      </small>
                    </span>
                  </label>
                  <button className="primary">
                    <FileCode2 size={16} /> Draft settings migration
                  </button>
                </fieldset>
              </SubmitForm>
              <p className="small muted">
                Network binding, TLS and authentication stay in server
                configuration and Agent access. These settings govern the
                selected workspace in Community and Managed; direct Rust writes
                bypass service validation.
              </p>
            </section>
          )}
        </div>
      )}
      <p className="schema-doc-link small muted">
        Schema migrations change definitions and service settings. Temporal
        records retain their original bytes.{" "}
        <Link to="/documentation/SCHEMA">
          Read the migration guide <ArrowRight size={13} />
        </Link>
      </p>
    </>
  );
}
