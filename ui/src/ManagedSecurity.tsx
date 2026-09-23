import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ShieldCheck, Monitor, KeyRound } from "lucide-react";
import { useAuth } from "./main";
import { Busy, Field, Head, SubmitForm, useAction } from "./shared";
import { managedApi } from "./managed-api";
interface Session {
  id: string;
  current: boolean;
  createdAt: number;
  expiresAt: number;
  ipAddress: string;
  userAgent: string;
  lastSeen: number;
}
export default function ManagedSecurity() {
  const { managed, refreshManaged } = useAuth(),
    user = managed?.user,
    action = useAction(),
    navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [nextPassword, setNextPassword] = useState("");
  const load = async () =>
    setSessions(
      (await managedApi<{ sessions: Session[] }>("/managed/sessions")).sessions,
    );
  useEffect(() => {
    void action.run(load);
  }, []);
  return (
    <>
      <Head
        title="Your account, protected."
        text="Manage your identity, authenticator and signed-in devices."
      />
      <section className="security-summary panel">
        <ShieldCheck size={32} />
        <div>
          <h2>{user?.name}</h2>
          <p>{user?.email}</p>
        </div>
        <span className="scope-badge">Authenticator enabled</span>
      </section>
      <div className="managed-two-column">
        <section className="panel form-panel">
          <h2>Verify a sensitive action</h2>
          <p>
            Confirm a new authenticator code to manage keys, secrets and team
            access for the next five minutes.
          </p>
          <SubmitForm
            onSubmit={() =>
              void action.run(async () => {
                await managedApi("/api/auth/two-factor/verify-totp", { code });
                setCode("");
                await refreshManaged();
              }, "Verified. Sensitive actions are available for five minutes.")
            }
          >
            <Field label="Authenticator code">
              <input
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Verify identity</Busy>
            </button>
          </SubmitForm>
        </section>
        <section className="panel form-panel">
          <h2>
            <KeyRound size={20} /> Change password
          </h2>
          {user?.hasPassword ? (
            <>
              <p>
                Changing your password signs out every device. You’ll sign in
                again with your authenticator.
              </p>
              <SubmitForm
                onSubmit={() =>
                  void action.run(async () => {
                    await managedApi("/api/auth/change-password", {
                      currentPassword: password,
                      newPassword: nextPassword,
                      revokeOtherSessions: true,
                    });
                    setPassword("");
                    setNextPassword("");
                    await refreshManaged();
                    navigate("/login");
                  })
                }
              >
                <Field label="Current password">
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    maxLength={128}
                  />
                </Field>
                <Field label="New password" hint="Use 15–128 characters.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={nextPassword}
                    onChange={(e) => setNextPassword(e.target.value)}
                    required
                    minLength={15}
                    maxLength={128}
                  />
                </Field>
                <button disabled={action.busy}>
                  <Busy busy={action.busy}>Update password</Busy>
                </button>
              </SubmitForm>
            </>
          ) : (
            <p>
              You sign in with GitHub. Your GitHub account manages your primary
              credentials; ChronoDB also requires your authenticator.
            </p>
          )}
        </section>
      </div>
      <section className="panel form-panel">
        <div className="section-head">
          <h2>Signed-in devices</h2>
          <button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await managedApi("/managed/sessions/revoke-others", {});
                await load();
              }, "Other sessions signed out.")
            }
          >
            Sign out other devices
          </button>
        </div>
        <p className="small muted">
          Sessions expire after 30 minutes idle or 12 hours total. Browser
          cookies are HttpOnly; API credentials are separate.
        </p>
        <div className="device-list">
          {sessions.map((s) => (
            <div className="device-row" key={s.id}>
              <Monitor size={22} />
              <div>
                <strong>
                  {s.current ? "This device" : "Another signed-in device"}
                </strong>
                <span>{s.userAgent || "Browser"}</span>
                <small>
                  {s.ipAddress} · Last active{" "}
                  {new Date(s.lastSeen || s.createdAt).toLocaleString()}
                </small>
              </div>
              <button
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await managedApi("/managed/sessions/revoke", { id: s.id });
                    if (s.current) {
                      await refreshManaged();
                      navigate("/login");
                    } else await load();
                  })
                }
              >
                Sign out
              </button>
            </div>
          ))}
        </div>
      </section>
      {action.feedback}
      <p className="small">
        <Link to="/documentation/HOSTED#accounts-and-project-permissions">
          Recovery and security documentation
        </Link>
      </p>
    </>
  );
}
