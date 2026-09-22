import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "./main";
import {
  Busy,
  Code,
  Field,
  Head,
  SubmitForm,
  useAction,
  Drawer,
} from "./shared";
import { managedApi } from "./managed-api";
interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  twoFactorEnabled: boolean;
}
interface Audit {
  seq: number;
  at: number;
  actor: string;
  actor_email: string | null;
  action: string;
  target: string;
  outcome: string;
  request_id: string;
}
export default function ManagedTeam() {
  const { connection } = useAuth(),
    action = useAction(),
    [tab, setTab] = useState("team"),
    [members, setMembers] = useState<Member[]>([]),
    [events, setEvents] = useState<Audit[]>([]),
    [nextCursor, setNextCursor] = useState<number | null>(null),
    [roles, setRoles] = useState<Record<string, string>>({});
  const [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [role, setRole] = useState("viewer"),
    [invite, setInvite] = useState<{
      url: string;
      email: string;
      expiresAt: number;
    } | null>(null);
  const [inviting, setInviting] = useState(false);
  const allowedRoles =
    connection?.account?.role === "owner"
      ? ["viewer", "editor", "admin", "owner"]
      : ["viewer", "editor"];
  const loadMembers = async () => {
    const r = await managedApi<{ members: Member[] }>("/managed/members");
    setMembers(r.members);
    setRoles(Object.fromEntries(r.members.map((m) => [m.id, m.role])));
  };
  const loadAudit = async (before?: number) => {
    const r = await managedApi<{ events: Audit[]; nextCursor: number | null }>(
      `/managed/audit${before ? `?before=${before}` : ""}`,
    );
    setEvents((old) => (before ? [...old, ...r.events] : r.events));
    setNextCursor(r.nextCursor);
  };
  useEffect(() => {
    void action.run(async () => {
      await Promise.all([loadMembers(), loadAudit()]);
    });
  }, []);
  return (
    <>
      <Head
        title="Your team. Clear accountability."
        text={`Manage access to ${connection?.project?.name || "this project"} and review its activity.`}
      />
      <div className="tabs" role="tablist" aria-label="Team settings">
        {["team", "audit"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t === "team" ? "Members & invitations" : "Audit trail"}
          </button>
        ))}
      </div>
      <p className="small muted">
        Sensitive changes require recent verification in{" "}
        <Link to="/app/security">Account security</Link>.
      </p>
      {tab === "team" ? (
        <>
          <button className="primary" onClick={() => setInviting(true)}>
            Invite collaborator
          </button>
          <Drawer
            open={inviting}
            onClose={() => {
              setInviting(false);
              setInvite(null);
            }}
            title="Invite a collaborator"
          >
            <section className="panel form-panel">
              <h2>Invite a collaborator</h2>
              <p>
                Ask collaborators to sign up with an available identity provider
                first. New email accounts need a platform operator invitation
                until email delivery is connected. Each invitation is bound to
                one account and this project.
              </p>
              <SubmitForm
                className="member-invite"
                onSubmit={() =>
                  void action.run(async () => {
                    setInvite(
                      await managedApi("/managed/invites", {
                        email,
                        name,
                        role,
                      }),
                    );
                    setEmail("");
                    setName("");
                    await loadMembers();
                  })
                }
              >
                <Field label="Name">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                  />
                </Field>
                <Field label="Email">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={254}
                  />
                </Field>
                <Field label="Project role">
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    {allowedRoles.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </Field>
                <button className="primary" disabled={action.busy}>
                  <Busy busy={action.busy}>Create invitation</Busy>
                </button>
              </SubmitForm>
              {invite && (
                <div className="notice">
                  <strong>Private invitation for {invite.email}</strong>
                  <p>
                    Share this directly with your collaborator. Email delivery
                    is not connected yet. Expires{" "}
                    {new Date(invite.expiresAt).toLocaleString()}.
                  </p>
                  <Code text={invite.url} />
                  <button onClick={() => setInvite(null)}>
                    Dismiss private link
                  </button>
                </div>
              )}
            </section>
            {action.feedback}
          </Drawer>
          <section className="panel form-panel">
            <h2>Project members</h2>
            <div className="table-scroll">
              <table className="managed-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Security</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <strong>{m.name}</strong>
                        <span>{m.email}</span>
                      </td>
                      <td>
                        <select
                          aria-label={`Role for ${m.email}`}
                          value={roles[m.id] || m.role}
                          disabled={!allowedRoles.includes(m.role)}
                          onChange={(e) =>
                            setRoles({ ...roles, [m.id]: e.target.value })
                          }
                        >
                          {Array.from(new Set([...allowedRoles, m.role])).map(
                            (r) => (
                              <option key={r}>{r}</option>
                            ),
                          )}
                        </select>
                      </td>
                      <td>
                        {m.twoFactorEnabled ? "MFA enabled" : "Setup pending"}
                      </td>
                      <td>{m.status}</td>
                      <td>
                        <div className="table-actions">
                          {m.status !== "invited" && (
                            <>
                              <button
                                disabled={
                                  action.busy ||
                                  roles[m.id] === m.role ||
                                  !allowedRoles.includes(m.role)
                                }
                                onClick={() =>
                                  void action.run(async () => {
                                    await managedApi(
                                      "/managed/members/update",
                                      {
                                        userId: m.id,
                                        role: roles[m.id],
                                        status: m.status,
                                      },
                                    );
                                    await loadMembers();
                                  }, "Member role updated.")
                                }
                              >
                                Save role
                              </button>
                              <button
                                disabled={
                                  action.busy || !allowedRoles.includes(m.role)
                                }
                                onClick={() =>
                                  void action.run(async () => {
                                    if (
                                      !window.confirm(
                                        `${m.status === "active" ? "Suspend" : "Restore"} ${m.email} in this project?`,
                                      )
                                    )
                                      return;
                                    await managedApi(
                                      "/managed/members/update",
                                      {
                                        userId: m.id,
                                        role: m.role,
                                        status:
                                          m.status === "active"
                                            ? "suspended"
                                            : "active",
                                      },
                                    );
                                    await loadMembers();
                                  })
                                }
                              >
                                {m.status === "active" ? "Suspend" : "Restore"}
                              </button>
                            </>
                          )}
                          {m.status === "invited" && (
                            <button
                              disabled={action.busy}
                              onClick={() =>
                                void action.run(async () => {
                                  setInvite(
                                    await managedApi(
                                      "/managed/invites/reissue",
                                      { userId: m.id },
                                    ),
                                  );
                                  await loadMembers();
                                })
                              }
                            >
                              Reissue invitation
                            </button>
                          )}
                          {m.status === "invited" && (
                            <button
                              disabled={action.busy}
                              onClick={() =>
                                void action.run(async () => {
                                  await managedApi("/managed/invites/revoke", {
                                    userId: m.id,
                                  });
                                  await loadMembers();
                                })
                              }
                            >
                              Revoke invitation
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <section className="panel form-panel">
          <div className="section-head">
            <h2>Project audit trail</h2>
            <button
              onClick={() => void action.run(() => loadAudit())}
              disabled={action.busy}
            >
              Refresh
            </button>
          </div>
          <p className="small muted">
            Append-only project events include actor, operation, outcome and
            request ID. Secret values and request bodies are excluded.
          </p>
          <div className="table-scroll">
            <table className="managed-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.seq}>
                    <td>{new Date(e.at).toLocaleString()}</td>
                    <td>{e.actor_email || e.actor}</td>
                    <td>{e.action}</td>
                    <td>{e.outcome}</td>
                    <td>
                      <code>{e.target}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!events.length && <p>No project events yet.</p>}
          {nextCursor && (
            <button
              disabled={action.busy}
              onClick={() => void action.run(() => loadAudit(nextCursor))}
            >
              Load older events
            </button>
          )}
        </section>
      )}
      {action.feedback}
    </>
  );
}
