import { useEffect, useState } from "react";
import { managedSite } from "./site";
import { api, bytes, download, graph, type Stats } from "./api";
import { Busy, DocLink, Head, useAction } from "./shared";
interface Backup {
  id: string;
  bytes: string;
  created_at: number;
}
export default function Operations() {
  const action = useAction(),
    [stats, setStats] = useState<Stats | null>(null),
    [backups, setBackups] = useState<Backup[]>([]);
  const refresh = async () => {
    const [s, b] = await Promise.all([
      graph<Stats>("stats"),
      api<{ backups: Backup[] }>("/v1/backups"),
    ]);
    setStats(s);
    setBackups(b.backups);
  };
  useEffect(() => {
    void action.run(refresh);
  }, []);
  return (
    <>
      <Head
        title="Keep memory dependable."
        text="Durability, recovery and workspace security."
      />
      {action.feedback}
      <div className="form-grid">
        <section className="panel form-panel">
          <h2>Storage health</h2>
          <dl>
            <div>
              <dt>Commit policy</dt>
              <dd>
                {stats
                  ? `${stats.default_durability === "fsync" ? "Fsync" : "Buffered"}${stats.require_fsync ? " · enforced by the operator" : " · workspace default"}`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Journal writer</dt>
              <dd>
                {stats?.writer_healthy === true
                  ? "Healthy"
                  : stats?.writer_healthy === false
                    ? "Recovery required — contact the operator"
                    : "Not reported by this engine"}
              </dd>
            </div>
            <div>
              <dt>Log size</dt>
              <dd>{stats ? bytes(stats.log_bytes) : "—"}</dd>
            </div>
            <div>
              <dt>Recovered torn tail</dt>
              <dd>{stats ? bytes(stats.recovered_tail_bytes) : "—"}</dd>
            </div>
          </dl>
          <p>
            API and MCP writes follow the effective commit policy shown above.
            Fsync synchronizes accepted writes before acknowledging them. An
            operator-enforced policy rejects requests to use buffered
            durability.
          </p>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await graph("sync");
                await refresh();
              }, "Log synchronized to disk.")
            }
          >
            <Busy busy={action.busy}>Synchronize log</Busy>
          </button>
        </section>
        <section className="panel form-panel">
          <h2>
            {managedSite
              ? "Account and application security"
              : "Credential security"}
          </h2>
          <p>
            {managedSite
              ? "Console access uses your account, MFA and project role. Applications and agents use separate scoped keys. Provider secrets belong in the encrypted vault."
              : "Use Connections & API keys to create and revoke scoped credentials. The console token stays in browser memory; reloading disconnects it."}
          </p>
          <DocLink to={managedSite ? "HOSTED" : "SECURITY"}>
            Security model and rotation
          </DocLink>
        </section>
      </div>
      <section className="panel form-panel">
        <div className="section-head">
          <div>
            <h2>Consistent backups</h2>
            <p>
              Capture a synchronized graph while writes are paused. Keep up to 3
              local copies; download them to separate storage.
            </p>
          </div>
          <button
            className="primary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api("/v1/backup", "POST", {});
                await refresh();
              }, "Consistent backup created.")
            }
          >
            <Busy busy={action.busy}>Create backup</Busy>
          </button>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Size</th>
                <th>Backup ID</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.created_at * 1000).toLocaleString()}</td>
                  <td>{bytes(b.bytes)}</td>
                  <td>{b.id.slice(0, 16)}…</td>
                  <td className="actions">
                    <button
                      className="text-link"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() =>
                          download(
                            `/v1/backups/${b.id}`,
                            "chronograph-backup.tar",
                          ),
                        )
                      }
                    >
                      Download
                    </button>
                    <button
                      className="ghost danger"
                      disabled={action.busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this local backup? Download it first if you need to keep it.",
                          )
                        )
                          void action.run(async () => {
                            await api(`/v1/backups/${b.id}`, "DELETE");
                            await refresh();
                          }, "Local backup deleted.");
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {backups.length === 0 && (
            <p className="empty-table">No local backups yet.</p>
          )}
        </div>
        <p className="small">
          Backups contain the journal, index snapshot and owned sidecars.
          {managedSite
            ? "Account, membership and vault recovery also requires the operator’s encrypted control-plane backup. Contact the operator to restore a project."
            : "Credentials are excluded; keep their external store in encrypted operator backups. Restore is an offline CLI operation into an empty directory."}
        </p>
        <DocLink to="OPERATIONS">
          Backup, restore and incident procedures
        </DocLink>
      </section>
      <section className="panel form-panel">
        <h2>Monitoring and production checks</h2>
        <p>
          Scrape the project’s authenticated <code>/v1/metrics</code> endpoint
          with a read key. Track writer health, journal growth, available
          workers and HTTP errors. Pair it with host disk, memory and backup-age
          monitoring.
        </p>
        <DocLink to="PRODUCTION">
          Deployment checks, alerts and recovery drills
        </DocLink>
      </section>
      <section className="panel form-panel">
        <h2>Export a current snapshot</h2>
        <p>
          Arrow IPC exports are available in the Temporal explorer for any
          timestamp. Use the Rust API for workspaces over the console’s
          1M-version export limit.
        </p>
        <button
          className="outline"
          disabled={action.busy}
          onClick={() =>
            void action.run(
              () =>
                download("/v1/export_arrow", "chronograph-now.arrow", {
                  t: (BigInt(Date.now()) * 1000n).toString(),
                }),
              "Current snapshot downloaded.",
            )
          }
        >
          Export now as Arrow
        </button>
      </section>
    </>
  );
}
