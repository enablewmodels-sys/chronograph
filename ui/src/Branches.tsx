import { useEffect, useState } from "react";
import {
  GitBranch,
  GitMerge,
  ArrowUpRight,
  Plus,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./main";
import { graph } from "./api";
import {
  Busy,
  Code,
  DocLink,
  Field,
  Head,
  SubmitForm,
  useAction,
} from "./shared";
import {
  useWorkspace,
  workspaceChanged,
  type ForkInfo,
  type MergeResult,
} from "./workspace";

function BranchHistory({
  forks,
  selected,
  onSelect,
}: {
  forks: ForkInfo[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const shown = [...forks].reverse().slice(0, 6).reverse();
  const height = Math.max(220, shown.length * 56 + 110);
  return (
    <div className="branch-history">
      <svg
        viewBox={`0 0 840 ${height}`}
        aria-label="Branch lineage from the main graph"
        role="img"
      >
        <path d={`M 35 50 H 805`} className="lineage-main" />
        <text x="35" y="28">
          Main
        </text>
        {shown.map((f, i) => {
          const x = 120 + i * 45,
            y = 108 + i * 56;
          return (
            <g
              key={f.id}
              className={`lineage-branch ${selected === f.id ? "is-selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`Select branch ${f.name}`}
              onClick={() => onSelect(f.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(f.id);
                }
              }}
            >
              <title>
                {f.name} · {f.timestamp} µs · {f.status}
              </title>
              <path d={`M ${x} 50 C ${x} ${y} 425 ${y} 595 ${y}`} />
              <circle cx={x} cy="50" r="5" />
              <circle cx="595" cy={y} r="6" />
              <text x="615" y={y + 4}>
                {f.name.length > 23 ? f.name.slice(0, 22) + "…" : f.name}
              </text>
              <text x="615" y={y + 21} className="lineage-time">
                {f.timestamp} µs · {f.status}
              </text>
            </g>
          );
        })}
        {!shown.length && (
          <text x="60" y="135" className="lineage-time">
            Your first branch will start here.
          </text>
        )}
      </svg>
      <p className="small muted">
        Lineage diagram · {shown.length} most recent branches · spacing is
        schematic.
      </p>
    </div>
  );
}
export default function Branches() {
  const { connection } = useAuth(),
    { forks, refresh, select, error, loading, more } = useWorkspace(),
    navigate = useNavigate(),
    action = useAction();
  const [selected, setSelected] = useState(""),
    [showCreate, setShowCreate] = useState(false),
    [name, setName] = useState("candidate policy"),
    [time, setTime] = useState("4000000"),
    [preview, setPreview] = useState<MergeResult | null>(null),
    [merged, setMerged] = useState<MergeResult | null>(null);
  const synthetic = connection?.edition === "synthetic",
    canWrite = connection?.credential.scope !== "read" && !synthetic;
  const chosen = forks.find((f) => f.id === selected);
  useEffect(() => {
    setPreview(null);
    setMerged(null);
  }, [selected]);
  const choose = (id: string) => setSelected(id);
  return (
    <>
      <Head
        title="Explore another future."
        text="Create an isolated branch from a moment in your graph."
      >
        <button
          className="primary"
          disabled={!canWrite || action.busy}
          onClick={() => setShowCreate((v) => !v)}
        >
          <Plus size={17} />
          Create branch
        </button>
      </Head>
      {synthetic && (
        <div className="notice informational">
          The synthetic preview is read only. Connect a Community workspace to
          create, persist and merge branches.{" "}
          <DocLink to="BRANCHES">Branch guide</DocLink>
        </div>
      )}
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {action.feedback}
      {showCreate && (
        <section className="panel form-panel create-branch-panel">
          <h2>Fork the main graph</h2>
          <p>
            Capture relationships active at this time. Later parent observations
            are excluded from the branch.
          </p>
          <SubmitForm
            className="branch-create-form"
            onSubmit={() =>
              void action.run(async () => {
                const result = await graph<{ fork: ForkInfo }>("fork", {
                  t: time,
                  name: name.trim(),
                });
                await refresh();
                setSelected(result.fork.id);
                setShowCreate(false);
              }, "Branch created and synchronized to disk.")
            }
          >
            <Field label="Branch name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={80}
              />
            </Field>
            <Field label="Fork timestamp (µs)">
              <input
                value={time}
                onChange={(e) => setTime(e.target.value)}
                required
                pattern="-?[0-9]+"
                inputMode="numeric"
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Create durable branch</Busy>
            </button>
          </SubmitForm>
          <p className="small muted">
            Merging requires an unchanged parent and no known future versions or
            finite expirations on the relationships you edit. For the sample
            dataset, its final observation is at 4,000,000 µs.
          </p>
        </section>
      )}
      <div className="branch-layout">
        <div>
          <section className="panel lineage-panel">
            <div className="section-head">
              <h2>Branch history</h2>
              <span className="scope-badge">
                {synthetic ? "No backend" : "Journal-backed"}
              </span>
            </div>
            <BranchHistory
              forks={forks}
              selected={selected}
              onSelect={choose}
            />
          </section>
          <section className="panel relationships branch-table">
            <div className="section-head">
              <h2>
                Branches <span className="muted">/ {forks.length}</span>
              </h2>
              <button
                className="ghost"
                disabled={loading}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                Refresh list
              </button>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Fork point (µs)</th>
                    <th>New versions</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {forks.map((f) => (
                    <tr
                      key={f.id}
                      className={f.id === selected ? "selected-row" : ""}
                    >
                      <td>
                        <button
                          className="ghost branch-name"
                          onClick={() => choose(f.id)}
                        >
                          <GitBranch size={15} />
                          {f.name}
                        </button>
                      </td>
                      <td>{f.timestamp}</td>
                      <td>{f.delta_edges}</td>
                      <td>
                        <span className={`scope-badge branch-${f.status}`}>
                          {f.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!forks.length && (
              <div className="branch-empty">
                <GitBranch size={30} />
                <h3>A place for the next possibility.</h3>
                <p>
                  Explore a different policy or relationship history from a
                  shared starting point.
                </p>
                <DocLink to="BRANCHES">How branches work</DocLink>
              </div>
            )}
            {more && (
              <p className="small muted">
                Showing the first 1,000 branch records. Use the API’s next_after
                cursor to inspect later records.
              </p>
            )}
          </section>
        </div>
        <aside className="panel branch-inspector">
          {chosen ? (
            <>
              <p className="eyebrow">Branch {chosen.id}</p>
              <h2>{chosen.name}</h2>
              <span className={`scope-badge branch-${chosen.status}`}>
                {chosen.status}
              </span>
              <dl>
                {[
                  ["Fork time (µs)", chosen.timestamp],
                  ["Parent revision", chosen.parent_revision],
                  ["Branch writes", chosen.revision],
                  ["Inherited versions", chosen.inherited_edges],
                  ["New versions", chosen.delta_edges],
                  ["New nodes", chosen.new_nodes],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {chosen.status === "active" ? (
                <div className="branch-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      select(chosen.id);
                      navigate("/app/explorer");
                    }}
                  >
                    <ArrowUpRight size={17} />
                    Explore branch
                  </button>
                  {canWrite && (
                    <button
                      className="outline"
                      onClick={() => {
                        select(chosen.id);
                        navigate("/app/write");
                      }}
                    >
                      Write into branch
                    </button>
                  )}
                  <button
                    className="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        setPreview(null);
                        const result = await graph<{ merge: MergeResult }>(
                          "preview_merge",
                          { fork: chosen.id },
                        );
                        setPreview(result.merge);
                      })
                    }
                  >
                    <GitMerge size={17} />
                    Preview merge
                  </button>
                  {preview?.fork === chosen.id && (
                    <div className="merge-review">
                      <h3>Merge review</h3>
                      <p>
                        {preview.nodes.length} new node mappings and{" "}
                        {preview.edges.length} inserted or changed edge
                        mappings. The server checked this against the parent.
                      </p>
                      <details>
                        <summary>Review exact ID mappings</summary>
                        <pre>{JSON.stringify(preview, null, 2)}</pre>
                      </details>
                      <button
                        className="primary"
                        disabled={!canWrite || action.busy}
                        onClick={() =>
                          void action.run(async () => {
                            const result = await graph<{ merge: MergeResult }>(
                              "merge",
                              { fork: chosen.id },
                            );
                            setMerged(result.merge);
                            setPreview(null);
                            select("");
                            workspaceChanged();
                            await refresh();
                          }, "Merged into main and synchronized. The branch is now closed.")
                        }
                      >
                        <GitMerge size={17} />
                        <Busy busy={action.busy}>Merge into main</Busy>
                      </button>
                      <p className="small">
                        Merge checks the parent again. Opaque payloads are
                        preserved; use the mappings for IDs stored by your
                        application.
                      </p>
                    </div>
                  )}
                  <button
                    className="ghost danger"
                    disabled={!canWrite || action.busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Discard branch “${chosen.name}”? Its branch data will close; main will be unchanged.`,
                        )
                      )
                        void action.run(async () => {
                          await graph("discard", { fork: chosen.id });
                          select("");
                          await refresh();
                        }, "Branch discarded and synchronized.");
                    }}
                  >
                    <Trash2 size={16} />
                    Discard branch
                  </button>
                </div>
              ) : (
                <>
                  <p>
                    This branch is closed. Its lifecycle metadata remains in the
                    journal.
                  </p>
                  {chosen.status === "merged" && (
                    <button
                      className="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          const result = await graph<{ merge: MergeResult }>(
                            "fork_info",
                            { fork: chosen.id },
                          );
                          setMerged(result.merge);
                        })
                      }
                    >
                      Read merge result
                    </button>
                  )}
                </>
              )}
              {merged?.fork === chosen.id && (
                <details className="merge-review" open>
                  <summary>Committed ID mappings</summary>
                  <pre>{JSON.stringify(merged, null, 2)}</pre>
                </details>
              )}
            </>
          ) : (
            <>
              <GitBranch size={28} />
              <h2>Select a future.</h2>
              <p>
                Inspect a branch to see its fork point, changes and merge
                eligibility.
              </p>
              <DocLink to="BRANCHES">Read the branch guide</DocLink>
            </>
          )}
          <div className="branch-note">
            <h3>One base. Independent changes.</h3>
            <p>
              Forks at the same revision and time share an immutable snapshot. A
              merge stops if the parent changed.
            </p>
          </div>
        </aside>
      </div>
      <section className="panel fork-example">
        <div>
          <p className="eyebrow">The hundred-future example</p>
          <h2>Try a policy. Keep its history.</h2>
          <p>
            The included gridworld example persists 100 independent rollouts,
            restores their states, and merges the best future.
          </p>
          <Link className="text-link" to="/documentation/BRANCHES">
            Run the example <ArrowUpRight size={16} />
          </Link>
        </div>
        <Code
          text={
            "cargo run --locked --release \\\n  -p chronograph-conn-worldmodel \\\n  --example fork_demo -- ./fork-demo"
          }
        />
      </section>
    </>
  );
}
