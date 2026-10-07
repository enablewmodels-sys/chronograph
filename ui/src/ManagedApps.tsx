import { useEffect, useState } from "react";
import { Plus, Rocket } from "lucide-react";
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
interface ManifestRead {
  name: string;
  present: boolean;
  source: string | null;
  valid: boolean;
  problem: string | null;
  text: string | null;
}
/**
 * The create panel's fields, before the request is assembled. Port, health path and
 * replicas start at what the platform's own example manifest declares, so a form
 * holding only a name still produces the documented shape.
 */
const EMPTY_FORM = {
  name: "",
  kind: "container",
  image: "",
  port: "8080",
  healthPath: "/healthz",
  replicas: "1",
  sizeGb: "",
  mount: "",
  envNames: "",
  overwrite: false,
  confirm: "",
};

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
  const createAction = useAction();
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
  const [form, setForm] = useState(EMPTY_FORM);
  const [manifestRead, setManifestRead] = useState<ManifestRead | null>(null);
  const [showManifest, setShowManifest] = useState(false);
  const loadDetail = async (name: string) => {
    const result = await managedApi<AppDetail>(
      "/managed/apps/" + encodeURIComponent(name),
    );
    setSelected(name);
    setDetail(result);
    setFrom(name + "-preview");
    setPlan(null);
    setShowManifest(false);
    try {
      setManifestRead(
        await managedApi<ManifestRead>(
          "/managed/apps/manifest?name=" + encodeURIComponent(name),
        ),
      );
    } catch {
      // The app summary already reports a manifest this console will not read, so
      // the read-only view is not offered instead of failing the page in front of
      // the person looking at it.
      setManifestRead(null);
    }
  };
  const load = async (preferred?: string) => {
    try {
      const result = await managedApi<{ apps: AppSummary[]; runtime: string }>(
        "/managed/apps",
      );
      setApps(result.apps);
      setRuntime(result.runtime);
      setDisabled(false);
      const wanted = preferred ?? selected;
      const name =
        wanted && result.apps.some((app) => app.name === wanted)
          ? wanted
          : (result.apps[0]?.name ?? "");
      if (name) await loadDetail(name);
      else {
        setSelected("");
        setDetail(null);
        setManifestRead(null);
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
  // Every option is sent only when it holds something, so an untouched field leaves
  // the server's own default in place, and no request can set a manifest field this
  // panel does not show.
  const createApp = () => {
    const name = form.name.trim();
    const body: Record<string, unknown> = { name, kind: form.kind };
    if (form.image.trim()) body.image = form.image.trim();
    if (form.port.trim()) body.port = Number(form.port);
    if (form.healthPath.trim()) body.healthPath = form.healthPath.trim();
    if (form.replicas.trim()) body.replicas = Number(form.replicas);
    if (form.sizeGb.trim()) body.sizeGb = Number(form.sizeGb);
    if (form.mount.trim()) body.mount = form.mount.trim();
    const envNames = form.envNames.split(/[\s,]+/).filter(Boolean);
    if (envNames.length > 0) body.envNames = envNames;
    if (form.overwrite) {
      body.overwrite = true;
      body.confirm = form.confirm.trim();
    }
    void createAction.run(async () => {
      await managedApi<{ app: AppSummary; source: string }>(
        "/managed/apps/create",
        body,
      );
      setForm(EMPTY_FORM);
      await load(name);
    }, "Manifest written. The app is deployable now.");
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
        {runtime === "dry-run"
          ? " No container runtime is installed on this host, so this deployment" +
            " runs appctl with the dry-run driver: a deploy is simulated, and the" +
            " recorded argv is exactly what a real deploy would run."
          : runtime
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
            No app is deployed in this project yet. A manifest in this project's
            manifests directory is what makes one deployable.
          </p>
        )}
        {!loaded && (
          <p className="empty-table" role="status">
            Reading this project's apps…
          </p>
        )}
      </section>
      <section className="panel form-panel app-create">
        <div className="section-head">
          <div>
            <h2>
              <Plus size={18} /> Create an app
            </h2>
            <p className="small muted">
              This console writes the manifest for you from the fields below,
              because it never accepts a manifest body. A manifest is what makes
              the app deployable; deploying it comes after.
            </p>
          </div>
        </div>
        {createAction.feedback}
        <div className="managed-two-column">
          <Field
            label="Name"
            hint="Lowercase letters, digits and dashes, starting with a letter."
          >
            <input
              name="name"
              value={form.name}
              maxLength={31}
              pattern="[a-z][a-z0-9-]{1,30}"
              placeholder="console-api"
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field
            label="Kind"
            hint="A container is the general case; a mobile app also needs its store artifacts."
          >
            <select
              name="kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              <option value="container">container</option>
              <option value="web">web</option>
              <option value="mobile">mobile</option>
            </select>
          </Field>
          <Field
            label="Image"
            hint="Optional. A prebuilt reference, such as ghcr.io/acme/app:1.4.0."
          >
            <input
              name="image"
              value={form.image}
              onChange={(e) => setForm({ ...form, image: e.target.value })}
            />
          </Field>
          <Field
            label="Port"
            hint="The port the app listens on inside its container."
          >
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </Field>
          <Field
            label="Health path"
            hint="An absolute path that answers 2xx when the app is ready."
          >
            <input
              name="healthPath"
              value={form.healthPath}
              onChange={(e) => setForm({ ...form, healthPath: e.target.value })}
            />
          </Field>
          <Field
            label="Replicas"
            hint="One container per environment; this runtime refuses more."
          >
            <input
              name="replicas"
              type="number"
              min={1}
              max={4}
              value={form.replicas}
              onChange={(e) => setForm({ ...form, replicas: e.target.value })}
            />
          </Field>
          <Field
            label="Persistence size in GB"
            hint="A database needs durable local storage. Fill this and the mount path together, or leave both empty for a stateless app."
          >
            <input
              name="sizeGb"
              type="number"
              min={1}
              value={form.sizeGb}
              onChange={(e) => setForm({ ...form, sizeGb: e.target.value })}
            />
          </Field>
          <Field
            label="Mount"
            hint="The absolute path inside the container that keeps its data. Required together with the size above."
          >
            <input
              name="mount"
              value={form.mount}
              placeholder="/data"
              onChange={(e) => setForm({ ...form, mount: e.target.value })}
            />
          </Field>
          <Field
            label="Environment variable names"
            hint="Names only, separated by commas. This console never accepts a value."
          >
            <input
              name="envNames"
              value={form.envNames}
              placeholder="CHRONOGRAPH_URL, LOG_LEVEL"
              onChange={(e) => setForm({ ...form, envNames: e.target.value })}
            />
          </Field>
        </div>
        <div className="app-create-write">
          <label className="check-field">
            <input
              type="checkbox"
              checked={form.overwrite}
              onChange={(e) =>
                setForm({ ...form, overwrite: e.target.checked })
              }
            />
            Replace a manifest this project already has
          </label>
          {form.overwrite && (
            <Field
              label="Confirm"
              hint="Repeat the app name; that echo is what makes replacing it deliberate."
            >
              <input
                name="confirm"
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
              />
            </Field>
          )}
        </div>
        <div className="table-actions app-actions">
          <button
            className="primary"
            disabled={createAction.busy}
            onClick={() => createApp()}
          >
            <Busy busy={createAction.busy}>Create manifest</Busy>
          </button>
          <button
            className="ghost"
            disabled={createAction.busy}
            onClick={() => setForm(EMPTY_FORM)}
          >
            Clear
          </button>
        </div>
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
          {manifestRead && manifestRead.present && (
            <p className="small muted app-manifest-source">
              Manifest source <code>{manifestRead.source}</code>.{" "}
              {manifestRead.valid
                ? "appctl accepts it as written."
                : (manifestRead.problem ?? "appctl refuses it.")}
            </p>
          )}
          {manifestRead && manifestRead.text !== null && (
            <div className="table-actions app-actions">
              <button
                className="outline"
                disabled={action.busy}
                onClick={() => setShowManifest(!showManifest)}
              >
                {showManifest ? "Hide manifest" : "View manifest"}
              </button>
            </div>
          )}
          {showManifest && manifestRead?.text && (
            <div className="app-manifest">
              <Code text={manifestRead.text} />
            </div>
          )}
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
