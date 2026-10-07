import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CircleCheck,
  Info,
  OctagonAlert,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Busy, Head, useAction } from "./shared";
import "./superadmin.css";

/* Read-only monitoring for the Managed deployment. The route is deliberately not
   gated on the client, because a client gate would be a suggestion rather than a
   control: the server rejects every caller that is not a superadmin, and this
   page renders its own signed-out and not-authorised states. Any field may be
   null when its probe fails; null renders as unknown or not reported, never as
   zero and never as a healthy value. The page shows only what the endpoint
   returns, and the endpoint returns no secrets. */

const UNKNOWN = "unknown";
const NOT_REPORTED = "not reported";

interface BackupReport {
  latestAt: number | null;
  latestBytes: number | null;
  count: number;
  stale: boolean;
}
interface DiskReport {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}
interface HostReport {
  uptimeSec: number;
  loadAvg: number[];
  cpuCount: number;
  cpuModel: string;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  disks: DiskReport[];
}
interface ServiceReport {
  unit: string;
  active: boolean | null;
  enabled: boolean | null;
  reason?: string;
}
interface EngineProcess {
  pid: number;
  rssBytes: number;
  elapsedSec: number;
  command: string;
}
interface EngineReport {
  count: number;
  limit: number;
  processes: EngineProcess[];
}
interface ProjectReport {
  id: string;
  name: string;
  ownerId: string;
  state: string;
  port: number;
  memberCount: number;
  ageSec: number;
  diskBytes: number;
  backup: BackupReport;
  engine: {
    reachable: boolean | null;
    revision: string | null;
    reason?: string;
  };
}
interface AccountReport {
  total: number;
  byStatus: { invited: number; active: number; suspended: number };
  byRole: { owner: number; admin: number; editor: number; viewer: number };
  mfaEnrolled: number;
  sessionsActive: number;
  invitesPending: number;
  invitesExpired: number;
  lastSignInAt: number | null;
}
interface BackupsReport {
  identity: BackupReport;
  ok: boolean;
}
interface AuditEvent {
  seq: number;
  at: number;
  actor: string;
  action: string;
  target: string;
  outcome: string;
}
interface AuditReport {
  recent: AuditEvent[];
  total: number;
}
interface TrafficReport {
  requests: number;
  clientErrors: number;
  serverErrors: number;
  rateLimited: number;
  since: number;
}
interface ReleaseReport {
  release: string | null;
  commit: string | null;
  edition: string | null;
  deployedAt: number | null;
}
interface AlertReport {
  level: "critical" | "warning" | "info";
  code: string;
  message: string;
  detail?: string;
}
/* Sections are nullable because a failed probe can return null for the whole
   section as well as for its fields. */
interface Overview {
  at: number;
  host: HostReport | null;
  services: ServiceReport[] | null;
  engines: EngineReport | null;
  projects: ProjectReport[] | null;
  accounts: AccountReport | null;
  backups: BackupsReport | null;
  audit: AuditReport | null;
  traffic: TrafficReport | null;
  release: ReleaseReport | null;
  alerts: AlertReport[] | null;
}
interface ChainCheck {
  ok: boolean;
  length: number;
  brokenAt: number | null;
  checkedAt: number;
}
/* The operator rosters. They are separate from the snapshot because they name people and
   list every grant, which the aggregate sections deliberately do not. The allowlist is
   shown because "who can open this panel" is answered only by the deployment's own
   configuration, which the console cannot read from anywhere else. */
interface OperatorAccount {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  operator: boolean;
  projects: number | null;
  sessions: number | null;
  lastSeenAt: number | null;
}
interface OperatorSession {
  email: string;
  createdAt: number | null;
  expiresAt: number | null;
  ipAddress: string;
  userAgent: string;
  assuranceAt?: number | null;
}
interface OperatorMembership {
  projectId: string;
  projectName: string;
  userId: string;
  email: string;
  role: string;
  status: string;
}
interface OperatorRoster {
  accounts: OperatorAccount[];
  sessions: OperatorSession[];
  memberships: OperatorMembership[];
  allowlist: string[];
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const body = payload as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw Object.assign(
      new Error(
        body?.error?.message ||
          body?.message ||
          (response.status === 403
            ? "Not authorised."
            : "The request could not be completed."),
      ),
      { status: response.status },
    );
  }
  return payload as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok)
    throw new Error(
      payload?.error?.message || "The operator action could not be completed.",
    );
  return payload as T;
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function formatBytes(value: number | null | undefined): string {
  if (!isNumber(value)) return UNKNOWN;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(size)} ${units[unit]}`;
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}
function formatDuration(value: number | null | undefined): string {
  if (!isNumber(value)) return UNKNOWN;
  const total = Math.max(0, Math.round(value));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}
function formatPercent(value: number | null | undefined): string {
  if (!isNumber(value)) return UNKNOWN;
  return `${Math.max(0, Math.min(100, value)).toFixed(0)}%`;
}
function formatCount(value: number | null | undefined): string {
  if (!isNumber(value)) return UNKNOWN;
  return value.toLocaleString();
}
/* Ports and process identifiers are read as digits, without grouping. */
function formatDigit(value: number | null | undefined): string {
  return isNumber(value) ? String(Math.trunc(value)) : UNKNOWN;
}
function formatStamp(value: number | null | undefined): string {
  if (!isNumber(value) || value <= 0) return UNKNOWN;
  /* Epoch seconds and epoch milliseconds are both accepted. */
  return new Date(value < 1e12 ? value * 1000 : value).toLocaleString();
}
function formatLoad(load: number[] | null | undefined): string {
  if (!load?.length) return UNKNOWN;
  return load
    .map((value) => (isNumber(value) ? value.toFixed(2) : UNKNOWN))
    .join(" / ");
}
function percentOf(
  part: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!isNumber(part) || !isNumber(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, (part / total) * 100));
}

function Panel({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <section className="superadmin-panel">
      <div className="superadmin-panel-head">
        <h2>{title}</h2>
        <p className="superadmin-hint">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/* Loading, probe failure and empty states for a section, so a section never
   renders a blank table. */
function Body({
  loading,
  reason,
  empty = false,
  emptyText = "",
  children,
}: {
  loading: boolean;
  reason: string;
  empty?: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  if (loading) return <p className="superadmin-note">Loading…</p>;
  if (reason)
    return <p className="superadmin-note superadmin-note-warn">{reason}</p>;
  if (empty) return <p className="superadmin-note">{emptyText}</p>;
  return <>{children}</>;
}

function Stat({
  label,
  value,
  mono = false,
  children,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="superadmin-stat">
      <dt>{label}</dt>
      <dd>
        {value !== undefined && (
          <strong className={mono ? "superadmin-mono" : undefined}>
            {value}
          </strong>
        )}
        {children}
      </dd>
    </div>
  );
}

function Bar({ percent, label }: { percent: number | null; label: string }) {
  if (!isNumber(percent))
    return <span className="superadmin-unknown">{UNKNOWN}</span>;
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="superadmin-bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
      aria-valuetext={formatPercent(value)}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function Flag({
  value,
  on,
  off,
  offTone = "muted",
}: {
  value: boolean | null;
  on: string;
  off: string;
  offTone?: "muted" | "danger";
}) {
  if (value === null || value === undefined)
    return <span className="superadmin-unknown">{UNKNOWN}</span>;
  if (value) return <span className="superadmin-on">{on}</span>;
  return (
    <span
      className={offTone === "danger" ? "superadmin-off-bad" : "superadmin-off"}
    >
      {off}
    </span>
  );
}

function Freshness({ stale }: { stale: boolean | null | undefined }) {
  return (
    <Flag
      value={typeof stale === "boolean" ? !stale : null}
      on="current"
      off="stale"
      offTone="danger"
    />
  );
}

export default function SuperAdmin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [status, setStatus] = useState("Loading the platform overview.");
  const [chain, setChain] = useState<ChainCheck | null>(null);
  const [roster, setRoster] = useState<OperatorRoster | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const verify = useAction();
  const act = useAction();

  /* The rosters load beside the snapshot and never fail the page: an operator who can read
     the fleet but not the account list is still better served than one shown an error. */
  const loadRoster = useCallback(async (signal?: AbortSignal) => {
    const [accounts, sessions, memberships] = await Promise.all([
      getJson<{ accounts: OperatorAccount[]; allowlist: string[] }>(
        "/managed/superadmin/accounts",
        signal,
      ),
      getJson<{ sessions: OperatorSession[] }>(
        "/managed/superadmin/sessions",
        signal,
      ),
      getJson<{ memberships: OperatorMembership[] }>(
        "/managed/superadmin/memberships",
        signal,
      ),
    ]);
    if (signal?.aborted) return;
    setRoster({
      accounts: accounts.accounts,
      allowlist: accounts.allowlist,
      sessions: sessions.sessions,
      memberships: memberships.memberships,
    });
  }, []);

  /* A manual refresh, on mount and on request only. No polling, and the request
     is aborted when the page unmounts. */
  const load = useCallback(async () => {
    inFlight.current?.abort();
    const control = new AbortController();
    inFlight.current = control;
    setLoading(true);
    setStatus("Refreshing the platform overview.");
    try {
      const next = await getJson<Overview>(
        "/managed/superadmin/overview",
        control.signal,
      );
      if (control.signal.aborted) return;
      const stamp = formatStamp(next.at);
      setOverview(next);
      setFailure("");
      setForbidden(false);
      setSignedOut(false);
      setStatus(
        `Updated ${new Date().toLocaleTimeString()}.` +
          (stamp === UNKNOWN ? "" : ` Probe reported ${stamp}.`),
      );
      await loadRoster(control.signal).catch(() => {});
    } catch (error) {
      if (control.signal.aborted) return;
      const status = (error as { status?: number }).status;
      const message =
        error instanceof Error
          ? error.message
          : "The request could not be completed.";
      setForbidden(status === 403);
      setSignedOut(status === 401);
      setFailure(message);
      setStatus(
        status === 403
          ? "Not authorised to read the platform overview."
          : status === 401
            ? "Sign in as a superadmin to read the platform overview."
            : `Refresh failed. ${message}`,
      );
    } finally {
      if (inFlight.current === control) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [loadRoster]);

  useEffect(() => {
    void load();
    return () => {
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [load]);

  const noData = !overview && !loading;
  const firstLoad = loading && !overview;
  const missing = (section: unknown) => overview !== null && section == null;
  const reasonFor = (section: unknown) =>
    noData
      ? "The overview did not load."
      : missing(section)
        ? "The probe did not report."
        : "";

  const alerts = overview?.alerts ?? [];
  const host = overview?.host ?? null;
  const disks = host?.disks ?? [];
  const services = overview?.services ?? [];
  const engines = overview?.engines ?? null;
  const processes = engines?.processes ?? [];
  const projects = overview?.projects ?? [];
  const accounts = overview?.accounts ?? null;
  const backups = overview?.backups ?? null;
  const identity = backups?.identity ?? null;
  const audit = overview?.audit ?? null;
  const events = audit?.recent ?? [];
  const release = overview?.release ?? null;
  const traffic = overview?.traffic ?? null;
  const memoryUsed =
    host &&
    isNumber(host.memoryTotalBytes) &&
    isNumber(host.memoryAvailableBytes)
      ? host.memoryTotalBytes - host.memoryAvailableBytes
      : null;
  const swapUsed =
    host && isNumber(host.swapTotalBytes) && isNumber(host.swapFreeBytes)
      ? host.swapTotalBytes - host.swapFreeBytes
      : null;
  const atLimit =
    engines !== null &&
    isNumber(engines.limit) &&
    engines.limit > 0 &&
    isNumber(engines.count) &&
    engines.count >= engines.limit;

  return (
    <div className="superadmin-page">
      <Head
        title="Platform status"
        text="A read-only probe of the Managed deployment: host capacity, systemd units, engine processes, projects, accounts, backups, the audit chain and the deployed release. Values update only when you refresh."
      >
        <button
          className="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <Busy busy={loading}>Refresh</Busy>
        </button>
      </Head>
      <p className="superadmin-status" role="status" aria-live="polite">
        {status}
      </p>
      {act.feedback}
      {failure && !forbidden && !signedOut && (
        <div className="notice error" role="alert">
          <strong>Overview unavailable.</strong> {failure}
        </div>
      )}
      {signedOut || forbidden ? (
        <section className="superadmin-denied">
          <ShieldAlert size={22} aria-hidden="true" />
          <div>
            <h2>{signedOut ? "Sign in required" : "Not authorised"}</h2>
            <p>
              {signedOut
                ? "This page shows the Managed deployment and needs a signed-in superadmin account."
                : "This account cannot read the platform overview, which requires a superadmin account."}
            </p>
            {signedOut && (
              <p className="superadmin-signin">
                <Link to="/login">Sign in</Link>
              </p>
            )}
          </div>
        </section>
      ) : (
        <>
          <Panel
            title="Alerts"
            hint="Conditions the deployment reports for operator attention."
          >
            <Body loading={firstLoad} reason={reasonFor(overview?.alerts)}>
              {alerts.length ? (
                <ul className="superadmin-alerts">
                  {alerts.map((alert, index) => (
                    <li
                      className={`superadmin-alert superadmin-alert-${alert.level}`}
                      key={`${alert.level}-${alert.code}-${index}`}
                    >
                      {alert.level === "critical" ? (
                        <OctagonAlert size={17} aria-hidden="true" />
                      ) : alert.level === "warning" ? (
                        <TriangleAlert size={17} aria-hidden="true" />
                      ) : (
                        <Info size={17} aria-hidden="true" />
                      )}
                      <div className="superadmin-alert-body">
                        <p>
                          <span className="superadmin-level">
                            {alert.level}
                          </span>
                          <code>{alert.code}</code>
                          {alert.message}
                        </p>
                        {alert.detail && (
                          <p className="superadmin-hint">{alert.detail}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="superadmin-clear">
                  <CircleCheck size={17} aria-hidden="true" />
                  The platform is clear. No alerts were reported.
                </p>
              )}
            </Body>
          </Panel>

          <Panel
            title="Host"
            hint="Capacity, load and disk headroom on the machine running the deployment."
          >
            <Body loading={firstLoad} reason={reasonFor(overview?.host)}>
              {host && (
                <>
                  <dl className="superadmin-grid">
                    <Stat
                      label="Uptime"
                      value={formatDuration(host.uptimeSec)}
                    />
                    <Stat
                      label="Load average (1 / 5 / 15 min)"
                      value={formatLoad(host.loadAvg)}
                    />
                    <Stat
                      label="CPU"
                      value={`${formatCount(host.cpuCount)} cores · ${host.cpuModel || UNKNOWN}`}
                    />
                    <Stat
                      label="Memory used"
                      value={`${formatBytes(memoryUsed)} of ${formatBytes(host.memoryTotalBytes)}`}
                    >
                      <Bar
                        percent={percentOf(memoryUsed, host.memoryTotalBytes)}
                        label="Memory used"
                      />
                    </Stat>
                    <Stat
                      label="Swap used"
                      value={`${formatBytes(swapUsed)} of ${formatBytes(host.swapTotalBytes)}`}
                    >
                      <Bar
                        percent={percentOf(swapUsed, host.swapTotalBytes)}
                        label="Swap used"
                      />
                    </Stat>
                  </dl>
                  {disks.length ? (
                    <div className="superadmin-scroll">
                      <table className="superadmin-table">
                        <caption>Disks</caption>
                        <thead>
                          <tr>
                            <th scope="col">Mount</th>
                            <th scope="col">Used</th>
                            <th scope="col">Free</th>
                            <th scope="col">Total</th>
                            <th scope="col">Usage</th>
                          </tr>
                        </thead>
                        <tbody>
                          {disks.map((disk) => (
                            <tr key={disk.path}>
                              <th scope="row">
                                <code>{disk.path}</code>
                              </th>
                              <td>{formatPercent(disk.usedPercent)}</td>
                              <td>{formatBytes(disk.freeBytes)}</td>
                              <td>{formatBytes(disk.totalBytes)}</td>
                              <td>
                                <Bar
                                  percent={disk.usedPercent}
                                  label={`Disk usage for ${disk.path}`}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="superadmin-note">No disks were reported.</p>
                  )}
                </>
              )}
            </Body>
          </Panel>

          <Panel
            title="Services"
            hint="Systemd units that back the deployment."
          >
            <Body
              loading={firstLoad}
              reason={reasonFor(overview?.services)}
              empty={overview !== null && !services.length}
              emptyText="No systemd units were reported."
            >
              <div className="superadmin-scroll">
                <table className="superadmin-table">
                  <caption>Systemd units</caption>
                  <thead>
                    <tr>
                      <th scope="col">Unit</th>
                      <th scope="col">Active</th>
                      <th scope="col">Enabled</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {services.map((service) => (
                      <tr key={service.unit}>
                        <th scope="row">
                          <code>{service.unit}</code>
                        </th>
                        <td>
                          <Flag
                            value={service.active}
                            on="active"
                            off="inactive"
                          />
                        </td>
                        <td>
                          <Flag
                            value={service.enabled}
                            on="enabled"
                            off="disabled"
                          />
                        </td>
                        <td className="superadmin-wrap">
                          {service.reason || (
                            <span className="superadmin-unknown">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Body>
          </Panel>

          <Panel
            title="Engines"
            hint="Engine processes running on the host and the provisioned limit."
          >
            <Body loading={firstLoad} reason={reasonFor(overview?.engines)}>
              {engines && (
                <p className="superadmin-note">
                  {`${formatCount(engines.count)} of ${formatCount(engines.limit)} engine processes running.${atLimit ? " At limit." : ""}`}
                </p>
              )}
              {processes.length ? (
                <div className="superadmin-scroll">
                  <table className="superadmin-table">
                    <caption>Engine processes</caption>
                    <thead>
                      <tr>
                        <th scope="col">PID</th>
                        <th scope="col">RSS</th>
                        <th scope="col">Elapsed</th>
                        <th scope="col">Command</th>
                      </tr>
                    </thead>
                    <tbody>
                      {processes.map((process) => (
                        <tr key={process.pid}>
                          <td>
                            <code>{formatDigit(process.pid)}</code>
                          </td>
                          <td>{formatBytes(process.rssBytes)}</td>
                          <td>{formatDuration(process.elapsedSec)}</td>
                          <td className="superadmin-wrap">
                            <code>{process.command || UNKNOWN}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : isNumber(engines?.count) && engines.count === 0 ? (
                <p className="superadmin-note">
                  No engine processes are running.
                </p>
              ) : (
                /* An unmeasured process list must not be reported as an empty
                   one: "nothing is running" is a claim, and it needs a count. */
                <p className="superadmin-note">
                  The engine process list was not reported.
                </p>
              )}
            </Body>
          </Panel>

          <Panel
            title="Projects"
            hint="Storage, backup freshness and engine reachability for every project."
          >
            <Body
              loading={firstLoad}
              reason={reasonFor(overview?.projects)}
              empty={overview !== null && !projects.length}
              emptyText="No projects exist on this deployment."
            >
              <div className="superadmin-scroll">
                <table className="superadmin-table">
                  <caption>Projects</caption>
                  <thead>
                    <tr>
                      <th scope="col">Project</th>
                      <th scope="col">Owner</th>
                      <th scope="col">State</th>
                      <th scope="col">Members</th>
                      <th scope="col">Age</th>
                      <th scope="col">Disk</th>
                      <th scope="col">Last backup</th>
                      <th scope="col">Engine</th>
                      <th scope="col">Control</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr key={project.id}>
                        <th scope="row">
                          <strong>{project.name || UNKNOWN}</strong>
                          <span>
                            <code>{project.id}</code> · port{" "}
                            {formatDigit(project.port)}
                          </span>
                        </th>
                        <td>{project.ownerId || UNKNOWN}</td>
                        <td>{project.state || UNKNOWN}</td>
                        <td>{formatCount(project.memberCount)}</td>
                        <td>{formatDuration(project.ageSec)}</td>
                        <td>{formatBytes(project.diskBytes)}</td>
                        <td>
                          <span>{formatStamp(project.backup?.latestAt)}</span>
                          {project.backup?.stale && (
                            <span className="superadmin-badge">stale</span>
                          )}
                        </td>
                        <td className="superadmin-wrap">
                          <Flag
                            value={project.engine?.reachable ?? null}
                            on="reachable"
                            off="unreachable"
                            offTone="danger"
                          />
                          <span>
                            <code>{project.engine?.revision || UNKNOWN}</code>
                          </span>
                          {project.engine?.reason && (
                            <span className="superadmin-hint">
                              {project.engine.reason}
                            </span>
                          )}
                        </td>
                        <td>
                          {/* A project whose engine died and whose backoff has not expired is
                              the reason this control exists: the runner re-spawns and waits for
                              its own readiness probe, so one click is the whole remedy. */}
                          <button
                            className="outline"
                            disabled={act.busy}
                            onClick={() =>
                              void act.run(async () => {
                                await postJson(
                                  "/managed/superadmin/projects/restart",
                                  { projectId: project.id },
                                );
                                await load();
                              }, "The engine was restarted.")
                            }
                          >
                            Restart engine
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Body>
          </Panel>

          <Panel
            title="Accounts"
            hint="Account states, roles, second-factor enrolment and session activity."
          >
            <Body loading={firstLoad} reason={reasonFor(overview?.accounts)}>
              {accounts && (
                <>
                  <dl className="superadmin-grid">
                    <Stat
                      label="Accounts"
                      value={formatCount(accounts.total)}
                    />
                    <Stat
                      label="Invited"
                      value={formatCount(accounts.byStatus?.invited)}
                    />
                    <Stat
                      label="Active"
                      value={formatCount(accounts.byStatus?.active)}
                    />
                    <Stat
                      label="Suspended"
                      value={formatCount(accounts.byStatus?.suspended)}
                    />
                    <Stat
                      label="Owners"
                      value={formatCount(accounts.byRole?.owner)}
                    />
                    <Stat
                      label="Admins"
                      value={formatCount(accounts.byRole?.admin)}
                    />
                    <Stat
                      label="Editors"
                      value={formatCount(accounts.byRole?.editor)}
                    />
                    <Stat
                      label="Viewers"
                      value={formatCount(accounts.byRole?.viewer)}
                    />
                    <Stat
                      label="MFA enrolled"
                      value={formatCount(accounts.mfaEnrolled)}
                    />
                    <Stat
                      label="Live sessions"
                      value={formatCount(accounts.sessionsActive)}
                    />
                    <Stat
                      label="Invites pending"
                      value={formatCount(accounts.invitesPending)}
                    />
                    <Stat
                      label="Invites expired"
                      value={formatCount(accounts.invitesExpired)}
                    />
                    <Stat
                      label="Last sign-in"
                      value={formatStamp(accounts.lastSignInAt)}
                    />
                  </dl>
                  {isNumber(accounts.total) && accounts.total === 0 && (
                    <p className="superadmin-note">
                      No accounts exist on this deployment.
                    </p>
                  )}
                </>
              )}
            </Body>
          </Panel>

          <Panel
            title="Operators"
            hint="Who can open this panel, and every account it belongs to. The allowlist is root-owned configuration: changing it needs host access, not a toggle here."
          >
            <Body loading={firstLoad} reason={reasonFor(roster?.accounts)}>
              {roster && (
                <>
                  <p className="superadmin-note">
                    {roster.allowlist.length
                      ? `Platform operators: ${roster.allowlist.join(", ")}.`
                      : "No platform operator is configured, so nobody can open this panel."}
                  </p>
                  <div className="superadmin-scroll">
                    <table className="superadmin-table">
                      <caption>Accounts</caption>
                      <thead>
                        <tr>
                          <th scope="col">Account</th>
                          <th scope="col">Operator</th>
                          <th scope="col">Role</th>
                          <th scope="col">State</th>
                          <th scope="col">Projects</th>
                          <th scope="col">Sessions</th>
                          <th scope="col">Last seen</th>
                          <th scope="col">Sign out everywhere</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster.accounts.map((account) => (
                          <tr key={account.id}>
                            <th scope="row">
                              <strong>{account.name || account.email || account.id}</strong>
                              <span>
                                <code>{account.email || account.id}</code>
                              </span>
                            </th>
                            <td>
                              <Flag
                                value={account.operator}
                                on="operator"
                                off="—"
                              />
                            </td>
                            <td>{account.role || UNKNOWN}</td>
                            <td>{account.status || UNKNOWN}</td>
                            <td>{formatCount(account.projects)}</td>
                            <td>{formatCount(account.sessions)}</td>
                            <td>{formatStamp(account.lastSeenAt)}</td>
                            <td>
                              <button
                                className="ghost danger"
                                disabled={
                                  act.busy ||
                                  !account.email ||
                                  !isNumber(account.sessions) ||
                                  account.sessions === 0
                                }
                                onClick={() => {
                                  if (
                                    !window.confirm(
                                      "Sign " +
                                        (account.email || account.id) +
                                        " out of every device? Their sessions are deleted and they must sign in again.",
                                    )
                                  )
                                    return;
                                  void act.run(async () => {
                                    await postJson(
                                      "/managed/superadmin/accounts/revoke-sessions",
                                      {
                                        userId: account.id,
                                        confirm: account.email,
                                      },
                                    );
                                    await load();
                                  }, "Every session for that account was revoked.");
                                }}
                              >
                                Revoke
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Body>
          </Panel>

          <Panel
            title="Active sessions"
            hint="Every live sign-in on this deployment. Session identifiers are deliberately not shown: this page returns no credentials."
          >
            <Body loading={firstLoad} reason={reasonFor(roster?.sessions)}>
              {roster &&
                (roster.sessions.length ? (
                  <div className="superadmin-scroll">
                    <table className="superadmin-table">
                      <caption>Live sessions</caption>
                      <thead>
                        <tr>
                          <th scope="col">Account</th>
                          <th scope="col">Signed in</th>
                          <th scope="col">Expires</th>
                          <th scope="col">Address</th>
                          <th scope="col">Client</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster.sessions.map((session, index) => (
                          <tr key={`${session.email}-${index}`}>
                            <th scope="row">
                              <code>{session.email || UNKNOWN}</code>
                            </th>
                            <td>{formatStamp(session.createdAt ?? session.assuranceAt ?? null)}</td>
                            <td>{formatStamp(session.expiresAt)}</td>
                            <td>{session.ipAddress || "not kept"}</td>
                            <td className="superadmin-wrap">
                              <code>{session.userAgent || "not kept"}</code>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="superadmin-note">
                    No live session was reported.
                  </p>
                ))}
            </Body>
          </Panel>

          <Panel
            title="Memberships"
            hint="Every project grant. Suspending one takes effect on the member's next request; a project's last active owner cannot be suspended."
          >
            <Body loading={firstLoad} reason={reasonFor(roster?.memberships)}>
              {roster &&
                (roster.memberships.length ? (
                  <div className="superadmin-scroll">
                    <table className="superadmin-table">
                      <caption>Project memberships</caption>
                      <thead>
                        <tr>
                          <th scope="col">Project</th>
                          <th scope="col">Account</th>
                          <th scope="col">Role</th>
                          <th scope="col">State</th>
                          <th scope="col">Change</th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster.memberships.map((member) => (
                          <tr key={`${member.projectId}-${member.userId}`}>
                            <th scope="row">
                              <strong>{member.projectName || member.projectId}</strong>
                              <span>
                                <code>{member.projectId}</code>
                              </span>
                            </th>
                            <td>
                              <code>{member.email || member.userId}</code>
                            </td>
                            <td>{member.role || UNKNOWN}</td>
                            <td>{member.status || UNKNOWN}</td>
                            <td>
                              <button
                                className={
                                  member.status === "active"
                                    ? "ghost danger"
                                    : "outline"
                                }
                                disabled={act.busy}
                                onClick={() => {
                                  const next =
                                    member.status === "active"
                                      ? "suspended"
                                      : "active";
                                  if (
                                    next === "suspended" &&
                                    !window.confirm(
                                      "Suspend " +
                                        (member.email || member.userId) +
                                        " in " +
                                        (member.projectName || member.projectId) +
                                        "? They lose access on their next request.",
                                    )
                                  )
                                    return;
                                  void act.run(async () => {
                                    await postJson(
                                      "/managed/superadmin/memberships/update",
                                      {
                                        projectId: member.projectId,
                                        userId: member.userId,
                                        status: next,
                                      },
                                    );
                                    await load();
                                  }, "The membership was updated.");
                                }}
                              >
                                {member.status === "active" ? "Suspend" : "Restore"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="superadmin-note">No membership exists.</p>
                ))}
            </Body>
          </Panel>
          <Panel
            title="Backups"
            hint="Identity archive and per-project backup freshness."
          >
            <Body loading={firstLoad} reason={reasonFor(overview?.backups)}>
              {backups && (
                <>
                  <p
                    className={
                      backups.ok
                        ? "superadmin-note"
                        : "superadmin-note superadmin-note-warn"
                    }
                  >
                    {backups.ok
                      ? "The identity archive and every project backup are current."
                      : "At least one backup is stale or missing. Check the report below."}
                  </p>
                  <dl className="superadmin-grid">
                    <Stat
                      label="Identity archive"
                      value={formatStamp(identity?.latestAt)}
                    />
                    <Stat
                      label="Identity size"
                      value={formatBytes(identity?.latestBytes)}
                    />
                    <Stat
                      label="Identity snapshots"
                      value={formatCount(identity?.count)}
                    />
                    <Stat label="Identity freshness">
                      <Freshness stale={identity?.stale} />
                    </Stat>
                  </dl>
                  {projects.length ? (
                    <div className="superadmin-scroll">
                      <table className="superadmin-table">
                        <caption>Project backups</caption>
                        <thead>
                          <tr>
                            <th scope="col">Project</th>
                            <th scope="col">Latest</th>
                            <th scope="col">Size</th>
                            <th scope="col">Snapshots</th>
                            <th scope="col">Freshness</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projects.map((project) => (
                            <tr key={project.id}>
                              <th scope="row">
                                <strong>{project.name || UNKNOWN}</strong>
                                <span>
                                  <code>{project.id}</code>
                                </span>
                              </th>
                              <td>{formatStamp(project.backup?.latestAt)}</td>
                              <td>
                                {formatBytes(project.backup?.latestBytes)}
                              </td>
                              <td>{formatCount(project.backup?.count)}</td>
                              <td>
                                <Freshness stale={project.backup?.stale} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="superadmin-note">
                      No project backups were reported.
                    </p>
                  )}
                </>
              )}
            </Body>
          </Panel>

          <Panel
            title="Audit"
            hint="Append-only platform events, newest first."
          >
            <div className="superadmin-panel-tools">
              <p className="superadmin-note">
                {audit
                  ? `${formatCount(events.length)} of ${formatCount(audit.total)} events shown.`
                  : "Event count not reported."}
              </p>
              <button
                className="outline"
                disabled={verify.busy}
                onClick={() =>
                  void verify.run(async () => {
                    setChain(
                      await getJson<ChainCheck>(
                        "/managed/superadmin/audit/verify",
                      ),
                    );
                  })
                }
              >
                <Busy busy={verify.busy}>Verify chain</Busy>
              </button>
            </div>
            {verify.feedback}
            {chain && (
              <p
                className={
                  chain.ok
                    ? "superadmin-result superadmin-result-ok"
                    : "superadmin-result superadmin-result-bad"
                }
                role="status"
                aria-live="polite"
              >
                {chain.ok
                  ? `Chain intact. ${formatCount(chain.length)} entries checked at ${formatStamp(chain.checkedAt)}.`
                  : `Chain not intact. First broken sequence ${formatCount(chain.brokenAt)}. ${formatCount(chain.length)} entries checked at ${formatStamp(chain.checkedAt)}.`}
              </p>
            )}
            <Body
              loading={firstLoad}
              reason={reasonFor(overview?.audit)}
              empty={overview !== null && !events.length}
              emptyText="No audit events were recorded."
            >
              <div className="superadmin-scroll">
                <table className="superadmin-table">
                  <caption>Recent audit events</caption>
                  <thead>
                    <tr>
                      <th scope="col">Seq</th>
                      <th scope="col">Time</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Action</th>
                      <th scope="col">Target</th>
                      <th scope="col">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event) => (
                      <tr key={event.seq}>
                        <th scope="row">{formatCount(event.seq)}</th>
                        <td>{formatStamp(event.at)}</td>
                        <td>{event.actor || UNKNOWN}</td>
                        <td>{event.action || UNKNOWN}</td>
                        <td className="superadmin-wrap">
                          <code>{event.target || UNKNOWN}</code>
                        </td>
                        <td>{event.outcome || UNKNOWN}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Body>
          </Panel>

          <Panel
            title="Release"
            hint="Deployed build and request counters for this deployment."
          >
            <Body loading={firstLoad} reason={reasonFor(release ?? traffic)}>
              {release ? (
                <dl className="superadmin-grid">
                  <Stat
                    label="Release directory"
                    value={release.release || NOT_REPORTED}
                    mono
                  />
                  <Stat
                    label="Commit"
                    value={release.commit || NOT_REPORTED}
                    mono
                  />
                  <Stat
                    label="Edition"
                    value={release.edition || NOT_REPORTED}
                  />
                  <Stat
                    label="Deployed"
                    value={formatStamp(release.deployedAt)}
                  />
                </dl>
              ) : (
                <p className="superadmin-note">The release was not reported.</p>
              )}
              {traffic ? (
                <dl className="superadmin-grid">
                  <Stat
                    label="Requests"
                    value={formatCount(traffic.requests)}
                  />
                  <Stat
                    label="Client errors"
                    value={formatCount(traffic.clientErrors)}
                  />
                  <Stat
                    label="Server errors"
                    value={formatCount(traffic.serverErrors)}
                  />
                  <Stat
                    label="Rate limited"
                    value={formatCount(traffic.rateLimited)}
                  />
                  <Stat
                    label="Counters since"
                    value={formatStamp(traffic.since)}
                  />
                </dl>
              ) : (
                <p className="superadmin-note">
                  The traffic counters were not reported.
                </p>
              )}
            </Body>
          </Panel>
        </>
      )}
    </div>
  );
}
