import { useEffect, useState } from "react";
import { Rocket } from "lucide-react";
import { managedApi } from "./managed-api";
import { Busy, Code, Field, Head, useAction } from "./shared";

interface AppManifest {
  present: boolean;
  valid: boolean;
  problem: string | null;
}
interface AppSummary {
  name: string;
  kind: string | null;
  environment: string | null;
  digest: string | null;
  image: string | null;
  health: string;
  lastAction: string | null;
  updatedAt: string | null;
  port: number | null;
  deployable: boolean;
  manifest: AppManifest;
}
interface AppEnvironment {
  env: string;
  container: string | null;
  running: boolean;
  health: string | null;
  port: number | null;
  digest: string | null;
  image: string | null;
  volume: string | null;
  sizeGb: number | null;
  action: string | null;
  updatedAt: string | null;
}
interface LedgerEntry {
  at: string;
  action: string;
  env: string;
  result: string;
  actor: string;
  digest?: string;
  image?: string;
  from?: string;
}
interface AppDetail {
  app: AppSummary;
  environments: AppEnvironment[];
  ledger: LedgerEntry[];
  ledgerTotal: number;
}
interface PlanStep {
  action: string;
  argv?: string[];
  note?: string;
}
interface PlanResult {
  app: string;
  env: string;
  driver: string;
  runtime: string;
  steps: PlanStep[];
}

/** The deployment has no hosting block: the routes are 404 with this code. */
const DISABLED_CODE = "HOSTING_DISABLED";
/**
 * WHY the message is decided here rather than in a toast: with hosting switched off the routes do
 * not exist, and that is a state of the deployment, not a failed action a person should retry.
 */
function isHostingDisabled(error: unknown) {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  return (
    code === DISABLED_CODE ||
    (code === "ACCESS_ERROR" &&
      message === "This workspace operation is not available.")
  );
}
function shortDigest(digest: string | null) {
  if (!digest) return "—";
  const value = digest.startsWith("sha256:") ? digest.slice(7) : digest;
  return value.slice(0, 12) + "…";
}
function when(at: string | null) {
  return at ? new Date(at).toLocaleString() : "—";
}
export default function ManagedApps() {
  const action = useAction();
  const [disabled, setDisabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [environment, setEnvironment] = useState("production");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("production");
  const [purge, setPurge] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const loadDetail = async (name: string) => {
    const result = await managedApi<AppDetail>(
      "/managed/apps/" + encodeURIComponent(name),
    );
    setSelected(name);
    setDetail(result);
    setFrom(name + "-preview");
    setPlan(null);
  };
  const load = async () => {
    try {
      const result = await managedApi<{ apps: AppSummary[]; runtime: string }>(
        "/managed/apps",
      );
      setApps(result.apps);
      setRuntime(result.runtime);
      setDisabled(false);
      const name =
        selected && result.apps.some((app) => app.name === selected)
          ? selected
          : (result.apps[0]?.name ?? "");
      if (name) await loadDetail(name);
      else {
        setSelected("");
        setDetail(null);
      }
    } catch (error) {
      if (isHostingDisabled(error)) {
        setDisabled(true);
        setApps([]);
        setDetail(null);
        return;
      }
      throw error;
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => {
    void action.run(load);
  }, []);
  if (disabled)
    return (
      <>
        <Head
          title="Apps"
          text="Deploy a container, web or mobile app from a manifest this project owns."
        />
        <section className="panel form-panel">
          <h2>
            <Rocket size={18} /> Hosting is not enabled for this deployment.
          </h2>
          <p>
            This control plane was started without an app hosting configuration,
            so the console has no appctl runtime to plan or deploy with. An
            operator enables it by adding a <code>hosting</code> block to the
            managed configuration with an absolute state directory, an absolute
            manifests directory and the container runtime to use.
          </p>
          <p className="small muted">
            Nothing else in this workspace is affected: your graph projects,
            credentials and members work as before.
          </p>
        </section>
      </>
    );
  const app = detail?.app ?? null;
  const planText = plan
    ? plan.steps
        .map(
          (step) =>
            [step.action, ...(step.argv ?? [])].join(" ") +
            (step.note ? "  # " + step.note : ""),
        )
        .join("\n")
    : "";
  return (
    <>
      <Head
        title="Apps"
        text="Every app this project hosts, what it is running, and the ledger of what was done to it."
      />
      <p className="small muted">
        A manifest in this project's manifests directory is what makes an app
        deployable. Deploying, promoting, rolling back and destroying are
        recorded in the app's ledger and in the workspace audit log.
        {runtime
          ? " This deployment runs appctl with the " + runtime + " runtime."
          : ""}
      </p>
      {action.feedback}
      <section className="panel form-panel">
        <h2>Project apps</h2>
        <div className="table-scroll">
          <table className="managed-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Kind</th>
                <th>Environment</th>
                <th>Health</th>
                <th>Active image</th>
                <th>Last action</th>
                <th>Updated</th>
                <th>Ledger</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((entry) => (
                <tr
                  key={entry.name}
                  className={entry.name === selected ? "selected" : undefined}
                >
                  <td>
                    <strong>{entry.name}</strong>
                    {entry.manifest.problem && (
                      <span>{entry.manifest.problem}</span>
                    )}
                  </td>
                  <td>{entry.kind ?? "—"}</td>
                  <td>{entry.environment ?? "—"}</td>
                  <td>{entry.health}</td>
                  <td title={entry.digest ?? undefined}>
                    <code>{shortDigest(entry.digest)}</code>
                  </td>
                  <td>{entry.lastAction ?? "—"}</td>
                  <td>{when(entry.updatedAt)}</td>
                  <td>
                    <button
                      className="ghost"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(() => loadDetail(entry.name))
                      }
                    >
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loaded && apps.length === 0 && (
          <p className="empty-table">
            No app is deployed in this project yet. A manifest under the
            project's manifests directory is what makes one deployable.
          </p>
        )}
        {!loaded && (
          <p className="empty-table" role="status">
            Reading this project's apps…
          </p>
        )}
      </section>
      {app && (
        <section className="panel form-panel">
          <div className="section-head">
            <div>
              <h2>{app.name}</h2>
              <p className="small muted">
                {app.deployable
                  ? "A manifest in this project's manifests directory is what makes this app deployable."
                  : "This app has no usable manifest, so it cannot be deployed from here."}
              </p>
            </div>
            <span className="scope-badge">{app.health}</span>
          </div>
          <div className="managed-two-column">
            <Field
              label="Environment"
              hint="production, preview or any other name this project uses."
            >
              <input
                name="environment"
                value={environment}
                maxLength={31}
                pattern="[a-z][a-z0-9-]{0,30}"
                onChange={(e) => setEnvironment(e.target.value)}
              />
            </Field>
            <Field
              label="Promote from"
              hint="Promotion replays the exact digest that environment ran."
            >
              <input
                name="from"
                value={from}
                maxLength={31}
                pattern="[a-z][a-z0-9-]{0,30}"
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>
            <Field label="Promote to">
              <input
                name="to"
                value={to}
                maxLength={31}
                pattern="[a-z][a-z0-9-]{0,30}"
                onChange={(e) => setTo(e.target.value)}
              />
            </Field>
          </div>
          <div className="table-actions app-actions">
            <button
              className="outline"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  setPlan(
                    await managedApi<PlanResult>("/managed/apps/plan", {
                      name: app.name,
                      environment,
                    }),
                  );
                }, "Plan ready. Nothing on the host was touched.")
              }
            >
              <Busy busy={action.busy}>Plan</Busy>
            </button>
            <button
              className="primary"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Deploy " +
                      app.name +
                      " into " +
                      environment +
                      "? The manifest that already exists in this project decides what runs.",
                  )
                )
                  return;
                void action.run(async () => {
                  await managedApi("/managed/apps/deploy", {
                    name: app.name,
                    environment,
                  });
                  await load();
                }, "Deploy finished. The ledger records it.");
              }}
            >
              Deploy
            </button>
            <button
              className="outline"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Promote the digest " +
                      from +
                      " is running into " +
                      to +
                      "?",
                  )
                )
                  return;
                void action.run(async () => {
                  await managedApi("/managed/apps/promote", {
                    name: app.name,
                    from,
                    to,
                  });
                  await load();
                }, "Promotion recorded.");
              }}
            >
              Promote
            </button>
            <button
              className="outline"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Run the previously recorded image again in " +
                      environment +
                      "?",
                  )
                )
                  return;
                void action.run(async () => {
                  await managedApi("/managed/apps/rollback", {
                    name: app.name,
                    environment,
                  });
                  await load();
                }, "Rollback recorded.");
              }}
            >
              Roll back
            </button>
            <label className="check-field">
              <input
                type="checkbox"
                checked={purge}
                onChange={(e) => setPurge(e.target.checked)}
              />
              Also delete the data volume
            </label>
            <button
              className="ghost danger"
              disabled={action.busy}
              onClick={() => {
                if (
                  !window.confirm(
                    "Destroy " +
                      app.name +
                      " in " +
                      environment +
                      (purge
                        ? " and delete its data volume? A deleted volume cannot be restored from here."
                        : "? Its data volume is kept."),
                  )
                )
                  return;
                void action.run(async () => {
                  await managedApi("/managed/apps/destroy", {
                    name: app.name,
                    environment,
                    purge,
                    // The server requires the app name echoed back, so a stale tab cannot
                    // destroy the wrong app.
                    confirm: app.name,
                  });
                  await load();
                }, "Destroy recorded.");
              }}
            >
              Destroy
            </button>
          </div>
          {app.manifest.problem && (
            <div className="notice error">{app.manifest.problem}</div>
          )}
          {plan && (
            <>
              <p className="small muted">
                {plan.steps.length} step(s) for {plan.app} in {plan.env}, using
                the {plan.driver} driver ({plan.runtime}). The runtime was not
                touched.
              </p>
              <Code text={planText} />
            </>
          )}
        </section>
      )}
      {app && detail && (
        <section className="panel form-panel">
          <div className="section-head">
            <div>
              <h2>Ledger</h2>
              <p className="small muted">
                {detail.ledgerTotal} recorded action(s), newest first.
              </p>
            </div>
          </div>
          <div className="table-scroll">
            <table className="managed-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Environment</th>
                  <th>Result</th>
                  <th>Image</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {detail.ledger.map((entry, index) => (
                  <tr key={entry.at + "-" + index}>
                    <td>{when(entry.at)}</td>
                    <td>{entry.action}</td>
                    <td>{entry.env}</td>
                    <td>{entry.result}</td>
                    <td title={entry.digest ?? undefined}>
                      <code>{shortDigest(entry.digest ?? null)}</code>
                    </td>
                    <td>
                      <code>{entry.actor}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.ledger.length === 0 && (
            <p className="empty-table">
              Nothing has been deployed for this app yet.
            </p>
          )}
          <div className="table-scroll">
            <table className="managed-table">
              <thead>
                <tr>
                  <th>Recorded environment</th>
                  <th>Container</th>
                  <th>Running</th>
                  <th>Recorded health</th>
                  <th>Port</th>
                  <th>Volume</th>
                  <th>Last action</th>
                </tr>
              </thead>
              <tbody>
                {detail.environments.map((entry) => (
                  <tr key={entry.env}>
                    <td>{entry.env}</td>
                    <td>
                      <code>{entry.container ?? "—"}</code>
                    </td>
                    <td>{entry.running ? "yes" : "no"}</td>
                    <td>{entry.health ?? "—"}</td>
                    <td>{entry.port ?? "—"}</td>
                    <td>{entry.volume ?? "—"}</td>
                    <td>{entry.action ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail.environments.length === 0 && (
            <p className="empty-table">No environment is recorded yet.</p>
          )}
        </section>
      )}
    </>
  );
}
