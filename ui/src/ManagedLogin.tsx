import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { ArrowLeft, Github, LockKeyhole, ShieldCheck } from "lucide-react";
import { publicPath } from "./site";
import { Busy, Field, Logo, SubmitForm, useAction } from "./shared";
import {
  socialSignIn,
  managedApi,
  type ManagedSession,
  type SocialProvider,
} from "./managed-api";

export function AccountFrame({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="account-page">
      <div className="account-top">
        <Logo />
        <Link to="/">
          Back to home <ArrowLeft size={16} />
        </Link>
      </div>
      <div className="account-layout">
        <section className="account-story">
          <h1>
            Build worlds
            <br />
            that remember.
          </h1>
          <p>
            Your models observe, predict and act. Give their decisions a history
            you can query.
          </p>
          <div className="account-promise">
            <ShieldCheck size={23} />
            <span>
              Private projects. Scoped access.
              <br />
              An authenticator protects your account.
            </span>
          </div>
          <Link to="/documentation/HOSTED">Explore ChronoDB Managed</Link>
          <img
            className="account-world"
            src={publicPath("/images/world/t1.webp")}
            width="1200"
            height="800"
            alt="A recorded moment in an illustrative world"
          />
        </section>
        <section className="account-form-panel">{children}</section>
      </div>
      <footer className="account-footer">
        ChronoDB Managed <span>Temporal memory for models that act.</span>
      </footer>
    </main>
  );
}
export default function ManagedLogin({
  session,
  refresh,
}: {
  session: ManagedSession | null;
  refresh: () => Promise<void>;
}) {
  const action = useAction(),
    location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [config, setConfig] = useState<{
    github: boolean;
    google: boolean;
  } | null>(null);
  const [enrollment, setEnrollment] = useState<{
    qrDataUrl: string;
    totpURI: string;
    backupCodes: string[];
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const socialStarted = useRef(false);
  useEffect(() => {
    void action.run(async () => {
      const c = await managedApi<{ github: boolean; google: boolean }>(
        "/managed/config",
      );
      setConfig(c);
      const provider = new URLSearchParams(location.search).get("provider");
      if (
        (provider === "github" || provider === "google") &&
        c[provider] &&
        !socialStarted.current &&
        !session?.user
      ) {
        socialStarted.current = true;
        await socialSignIn(provider);
      }
    });
  }, []);
  const user = session?.user;
  if (user && !user.needsMfa && user.twoFactorEnabled && !user.needsActivation)
    return <Navigate to={session.project ? "/app" : "/projects"} replace />;
  const verify = () =>
    action.run(async () => {
      await managedApi(
        recovery
          ? "/api/auth/two-factor/verify-backup-code"
          : "/api/auth/two-factor/verify-totp",
        { code: code.trim(), trustDevice: false },
      );
      setCode("");
      setPassword("");
      setEnrollment(null);
      await refresh();
    });
  return (
    <AccountFrame>
      {user && !user.twoFactorEnabled ? (
        <>
          <span className="account-symbol">
            <ShieldCheck size={24} />
          </span>
          <h2>Secure your account.</h2>
          <p>Connect an authenticator app before entering your projects.</p>
          {!enrollment ? (
            <SubmitForm
              onSubmit={() =>
                void action.run(async () => {
                  setEnrollment(
                    await managedApi("/api/auth/two-factor/enable", {
                      ...(user.hasPassword ? { password } : {}),
                      method: "totp",
                    }),
                  );
                  setPassword("");
                })
              }
            >
              {user.hasPassword && (
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
              )}
              <button className="primary" disabled={action.busy}>
                <Busy busy={action.busy}>Set up authenticator</Busy>
              </button>
            </SubmitForm>
          ) : (
            <>
              <img
                className="auth-qr"
                src={enrollment.qrDataUrl}
                alt="Scan this QR code using your authenticator app"
                width={240}
                height={240}
              />
              <details className="account-details">
                <summary>Enter setup key manually</summary>
                <code className="secret-text">
                  {new URL(enrollment.totpURI).searchParams.get("secret")}
                </code>
              </details>
              <details className="account-details" open>
                <summary>Save your recovery codes</summary>
                <p className="small">
                  Each code works once. Store these in your password manager;
                  they replace an authenticator code if you lose your device.
                </p>
                <div className="recovery-codes">
                  {enrollment.backupCodes.map((c) => (
                    <code key={c}>{c}</code>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void action.run(async () => {
                      await navigator.clipboard.writeText(
                        enrollment.backupCodes.join("\n"),
                      );
                    }, "Recovery codes copied.")
                  }
                >
                  Copy recovery codes
                </button>
              </details>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                I saved my recovery codes.
              </label>
              <SubmitForm onSubmit={() => void verify()}>
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
                <button className="primary" disabled={action.busy || !saved}>
                  <Busy busy={action.busy}>Verify and continue</Busy>
                </button>
              </SubmitForm>
            </>
          )}
        </>
      ) : challenge || user ? (
        <>
          <span className="account-symbol">
            <LockKeyhole size={24} />
          </span>
          <h2>
            {recovery ? "Use a recovery code." : "One more security check."}
          </h2>
          <p>
            {recovery
              ? "Enter one of the recovery codes you saved during setup."
              : "Enter the six-digit code from your authenticator app."}
          </p>
          <SubmitForm onSubmit={() => void verify()}>
            <Field label={recovery ? "Recovery code" : "Authenticator code"}>
              <input
                autoFocus
                autoComplete="one-time-code"
                inputMode={recovery ? "text" : "numeric"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                maxLength={recovery ? 100 : 6}
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Verify and continue</Busy>
            </button>
          </SubmitForm>
          <button
            className="text-link"
            onClick={() => {
              setRecovery(!recovery);
              setCode("");
            }}
          >
            {recovery ? "Use authenticator instead" : "Use a recovery code"}
          </button>
        </>
      ) : (
        <>
          <h2>Welcome to ChronoDB.</h2>
          <p>Sign in to your projects.</p>
          {new URLSearchParams(location.search).has("error") && (
            <div className="notice error" role="alert">
              Sign-in could not be completed. Use a verified provider email and
              try again.
            </div>
          )}
          {(["google", "github"] as SocialProvider[])
            .filter((provider) => config?.[provider])
            .map((provider) => (
              <button
                key={provider}
                className={provider + "-signin"}
                disabled={action.busy}
                onClick={() => void action.run(() => socialSignIn(provider))}
              >
                {provider === "github" ? <Github size={19} /> : <GoogleMark />}
                Continue with {provider === "google" ? "Google" : "GitHub"}
              </button>
            ))}
          <div className="form-divider">
            <span>or sign in with email</span>
          </div>
          <SubmitForm
            onSubmit={() =>
              void action.run(async () => {
                const result = await managedApi<{
                  twoFactorRedirect?: boolean;
                }>("/api/auth/sign-in/email", { email, password });
                setPassword("");
                if (result.twoFactorRedirect) setChallenge(true);
                else await refresh();
              })
            }
          >
            <Field label="Email address">
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={128}
              />
            </Field>
            <button className="primary" disabled={action.busy}>
              <Busy busy={action.busy}>Sign in</Busy>
            </button>
          </SubmitForm>
          <details className="account-details">
            <summary>New here or forgot your password?</summary>
            <p>
              Use an available sign-in provider to create an account. Email
              accounts start with a private invitation from your administrator.
              Automated email recovery will be available when email delivery is
              connected.
            </p>
            <Link to="/documentation/HOSTED#accounts-and-project-permissions">
              Account recovery options
            </Link>
          </details>
        </>
      )}
      {action.feedback}
      {user && (
        <button
          className="text-link"
          onClick={() =>
            void action.run(async () => {
              await managedApi("/api/auth/sign-out", {});
              await refresh();
            })
          }
        >
          Sign out
        </button>
      )}
      <p className="account-terms">
        By continuing, you agree to the{" "}
        <Link to="/documentation/HOSTED">Managed preview terms and limits</Link>
        .
      </p>
    </AccountFrame>
  );
}

export function ActivateAccount() {
  const action = useAction();
  const token = useRef(
    new URLSearchParams(window.location.hash.slice(1)).get("token") || "",
  );
  const [invite, setInvite] = useState<{ email: string; name: string } | null>(
      null,
    ),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [done, setDone] = useState(false);
  useEffect(() => {
    window.history.replaceState(null, "", window.location.pathname);
    void action.run(async () =>
      setInvite(
        await managedApi("/managed/invitation", { token: token.current }),
      ),
    );
  }, []);
  return (
    <AccountFrame>
      <h2>{done ? "Your account is ready." : "Make yourself at home."}</h2>
      {done ? (
        <>
          <p>
            Your password is set. Sign in, then add an authenticator to protect
            your account.
          </p>
          <Link className="button primary" to="/login">
            Continue to sign in
          </Link>
        </>
      ) : (
        <>
          <p>
            Set a password for your ChronoDB account. This private link works
            once.
          </p>
          {invite && (
            <>
              <p className="account-email">{invite.email}</p>
              <SubmitForm
                onSubmit={() =>
                  void action.run(async () => {
                    if (password !== confirm)
                      throw new Error("The passwords do not match.");
                    await managedApi("/api/auth/reset-password", {
                      token: token.current,
                      newPassword: password,
                    });
                    token.current = "";
                    setPassword("");
                    setConfirm("");
                    setDone(true);
                  })
                }
              >
                <Field
                  label="New password"
                  hint="15–128 characters. A unique passphrase works well."
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </Field>
                <Field label="Confirm password">
                  <input
                    type="password"
                    autoComplete="new-password"
                    minLength={15}
                    maxLength={128}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                  />
                </Field>
                <button className="primary" disabled={action.busy}>
                  <Busy busy={action.busy}>Create password</Busy>
                </button>
              </SubmitForm>
            </>
          )}
        </>
      )}
      {action.feedback}
    </AccountFrame>
  );
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.59-4.12H3.07v2.59A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#FBBC05"
        d="M6.41 13.92a6 6 0 0 1 0-3.84V7.49H3.07a10 10 0 0 0 0 9.02l3.34-2.59Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.88-2.88A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.93 5.49l3.34 2.59A6 6 0 0 1 12 5.96Z"
      />
    </svg>
  );
}
