import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  Activity,
  BookOpen,
  Database,
  Home,
  KeyRound,
  LogOut,
  Network,
  Settings2,
  ArrowLeft,
  GitBranch,
  Plug,
  ShieldCheck,
  Users,
  LockKeyhole,
  Menu,
  ChevronDown,
  Rocket,
} from "lucide-react";
import "@fontsource-variable/manrope";
import "./style.css";
import "./schema.css";
import { SchemaProvider } from "./schema-store";
import { api, setToken, useDemo, demoConnection, type Connection } from "./api";
import { Busy, Field, Logo, SubmitForm, useAction, Drawer } from "./shared";
import Landing from "./Landing";
import { managedSite, publicSite } from "./site";
import {
  managedApi,
  setManagedProject,
  type ManagedSession,
} from "./managed-api";
const ManagedLogin = lazy(() => import("./ManagedLogin"));
const ActivateAccount = lazy(() =>
  import("./ManagedLogin").then((m) => ({ default: m.ActivateAccount })),
);
const ForgotPassword = lazy(() =>
  import("./ManagedLogin").then((m) => ({ default: m.ForgotPassword })),
);
const ManagedProjects = lazy(() => import("./ManagedProjects"));
const JoinProject = lazy(() =>
  import("./ManagedProjects").then((m) => ({ default: m.JoinProject })),
);
import "./managed.css";
import "./theme.css";
import { PolicyLinks } from "./SiteFooter";
const LegalPage = lazy(() => import("./LegalPage"));
import { BranchPicker, WorkspaceProvider } from "./workspace";
const BCI = lazy(() => import("./BCI"));
const BCIPage = lazy(() =>
  import("./BCI").then((m) => ({ default: m.BCIPage })),
);
const Explorer = lazy(() => import("./Explorer"));
const Overview = lazy(() => import("./Overview"));
const Schema = lazy(() => import("./SchemaWorkspace"));
const Write = lazy(() => import("./Write"));
const Access = lazy(() => import("./Access"));
const Operations = lazy(() => import("./Operations"));
const Documentation = lazy(() => import("./Documentation"));
const Pricing = lazy(() => import("./Pricing"));
const SuperAdmin = lazy(() => import("./SuperAdmin"));
const Branches = lazy(() => import("./Branches"));
const Connectors = lazy(() => import("./Connectors"));
const ManagedSecurity = lazy(() => import("./ManagedSecurity"));
const ManagedTeam = lazy(() => import("./ManagedTeam"));
const ManagedSecrets = lazy(() => import("./ManagedSecrets"));
const ManagedApps = lazy(() => import("./ManagedApps"));
const AuthContext = createContext<{
  connection: Connection | null;
  update: (s: Connection | null) => void;
  managed: ManagedSession | null;
  refreshManaged: () => Promise<void>;
}>({
  connection: null,
  update: () => {},
  managed: null,
  refreshManaged: async () => {},
});
export const useAuth = () => useContext(AuthContext);
function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);
  const [connection, setConnection] = useState<Connection | null>(
    publicSite ? demoConnection : null,
  );
  const [managed, setManaged] = useState<ManagedSession | null>(null);
  // The account probe is bounded, so this cannot stick on forever.
  const [loadingAccount, setLoadingAccount] = useState(managedSite);
  // True only when the account probe itself failed. A signed-out visitor answered by
  // the account service is not an error, and a project that will not connect is a
  // different failure, so the two must not be shown the same way.
  const [accountError, setAccountError] = useState(false);
  const accountAnswered = useRef(false);
  const refreshManaged = useCallback(async () => {
    setManagedProject("");
    const next = await managedApi<ManagedSession>("/managed/session");
    accountAnswered.current = true;
    setAccountError(false);
    setManagedProject(next.project?.id || "");
    if (
      next.user &&
      !next.user.needsMfa &&
      !next.user.needsActivation &&
      next.project
    ) {
      try {
        const connected = await api<Connection>("/v1/info");
        setConnection(connected);
        setManaged(next);
      } catch (error) {
        setConnection(null);
        setManaged(next);
        throw error;
      }
    } else {
      setConnection(null);
      setManaged(next);
    }
  }, []);
  useEffect(() => {
    if (!managedSite) return;
    // The account probe is bounded in managed-api.ts, so the sign-in form still
    // renders when the account service is unreachable. A failure clears the graph
    // connection only: the account session is the server's answer and has to
    // survive an unreachable project, or a transient API error signs out a user
    // who is still authenticated.
    accountAnswered.current = false;
    void refreshManaged()
      .catch(() => {
        setConnection(null);
        // The account service did not answer, so the browser cannot say whether the
        // visitor is signed in. Sending them to the sign-in form reads as a broken
        // session; say what happened and offer the retry instead.
        setAccountError(!accountAnswered.current);
      })
      .finally(() => setLoadingAccount(false));
  }, [refreshManaged]);
  const retryAccount = useCallback(() => {
    setLoadingAccount(true);
    accountAnswered.current = false;
    void refreshManaged()
      .catch(() => setAccountError(!accountAnswered.current))
      .finally(() => setLoadingAccount(false));
  }, [refreshManaged]);
  const update = (s: Connection | null) => {
    setConnection(s);
    if (!s) setToken("");
    if (!s && managedSite) {
      setManaged(null);
      setManagedProject("");
    }
  };
  useEffect(() => {
    const expire = () => update(null);
    window.addEventListener("session-expired", expire);
    return () => {
      window.removeEventListener("session-expired", expire);
    };
  }, []);
  return (
    <AuthContext.Provider
      value={{ connection, update, managed, refreshManaged }}
    >
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Suspense
        fallback={
          <p className="loading" role="status">
            Loading workspace…
          </p>
        }
      >
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/bci" element={<BCIPage />} />
          <Route
            path="/login"
            element={
              managedSite ? (
                loadingAccount ? (
                  <p className="loading" role="status">
                    Checking your account…
                  </p>
                ) : (
                  <ManagedLogin session={managed} refresh={refreshManaged} />
                )
              ) : connection ? (
                <Navigate to="/app" replace />
              ) : publicSite ? (
                <Navigate to="/" replace />
              ) : (
                <Login />
              )
            }
          />
          <Route path="/documentation/*" element={<Documentation />} />
          <Route path="/pricing" element={<Pricing />} />
          {/* Operator-only, and not a public surface: the panel is not mounted at all
              without an account session that the control plane marks as superadmin.
              The server still authorises every request, so this is a second gate. */}
          <Route
            path="/admin"
            element={
              !managedSite ? (
                <Navigate to="/" replace />
              ) : loadingAccount ? (
                <p className="loading" role="status">
                  Checking your account…
                </p>
              ) : accountError ? (
                <AccountUnavailable retry={retryAccount} />
              ) : managed?.superadmin ? (
                <SuperAdmin />
              ) : managed?.user ? (
                // Signed in, but not the operator. Saying so is kinder than a silent
                // bounce to the sign-in form, which reads as a broken session.
                <div className="standalone-security">
                  <Logo />
                  <Link to="/projects">Back to projects</Link>
                  <h2>Operator access required.</h2>
                  <p>
                    This panel belongs to the platform operator account. Your
                    own projects are unaffected.
                  </p>
                </div>
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          {[
            "privacy",
            "terms",
            "data-protection",
            "security",
            "subprocessors",
            "cookies",
            "acceptable-use",
            "legal",
            "support",
            "status",
          ].map((path) => (
            <Route key={path} path={`/${path}`} element={<LegalPage />} />
          ))}
          {managedSite && (
            <>
              <Route path="/activate" element={<ActivateAccount />} />
              <Route path="/reset-password" element={<ActivateAccount />} />
              <Route path="/verify-email" element={<ActivateAccount />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route
                path="/signup"
                element={
                  loadingAccount ? (
                    <p className="loading">Checking your account…</p>
                  ) : (
                    <ManagedLogin
                      key="signup"
                      session={managed}
                      refresh={refreshManaged}
                    />
                  )
                }
              />
              <Route
                path="/join"
                element={<JoinProject refresh={refreshManaged} />}
              />
              <Route
                path="/projects"
                element={
                  loadingAccount ? (
                    <p className="loading">Loading projects…</p>
                  ) : accountError ? (
                    <AccountUnavailable retry={retryAccount} />
                  ) : managed?.user &&
                    !managed.user.needsMfa &&
                    !managed.user.needsActivation ? (
                    <ManagedProjects
                      session={managed}
                      refresh={refreshManaged}
                    />
                  ) : (
                    <Navigate to="/login" replace />
                  )
                }
              />
              <Route
                path="/account/security"
                element={
                  managed?.user && !managed.user.needsMfa ? (
                    <div className="standalone-security">
                      <Logo />
                      <Link to="/projects">Back to projects</Link>
                      <ManagedSecurity />
                    </div>
                  ) : (
                    <Navigate to="/login" replace />
                  )
                }
              />
            </>
          )}
          <Route
            path="/app/*"
            element={
              loadingAccount ? (
                <p className="loading" role="status">
                  Loading workspace…
                </p>
              ) : accountError ? (
                <AccountUnavailable retry={retryAccount} />
              ) : connection ? (
                <Console key={connection.project?.id || "community"} />
              ) : (
                <Navigate
                  to={
                    managed?.user &&
                    !managed.user.needsMfa &&
                    !managed.user.needsActivation
                      ? "/projects"
                      : "/login"
                  }
                  replace
                />
              )
            }
          />
          <Route
            path="*"
            element={
              <div className="not-found">
                <Logo />
                <h1>That page is not here.</h1>
                <Link to="/">Return home</Link>
              </div>
            }
          />
        </Routes>
      </Suspense>
    </AuthContext.Provider>
  );
}
function Login() {
  const { update } = useAuth(),
    action = useAction(),
    [token, setInputToken] = useState("");
  return (
    <main id="main" className="login-page">
      <Logo />
      <div className="login-content">
        <h1>Welcome to your workspace.</h1>
        <p>
          Connect with a scoped API token. It stays in memory and is cleared on
          reload.
        </p>
        <SubmitForm
          onSubmit={() =>
            void action.run(async () => {
              setToken(token.trim());
              try {
                update(await api<Connection>("/v1/info"));
                setInputToken("");
              } catch (error) {
                setToken("");
                throw error;
              }
            })
          }
        >
          <Field label="API token">
            <input
              autoFocus
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setInputToken(e.target.value)}
              required
              maxLength={84}
            />
          </Field>
          <button className="primary" disabled={action.busy}>
            <Busy busy={action.busy}>Connect workspace</Busy>
          </button>
          {action.feedback}
        </SubmitForm>
        <p className="small">
          {managedSite
            ? "Use the token issued by your workspace operator. "
            : "Create a token with chronograph-server admin create-token. "}
          Read tokens can explore; ingest tokens can write; admin tokens manage
          access and backups.
        </p>
        <button
          className="outline"
          onClick={() => {
            useDemo();
            update(demoConnection);
          }}
        >
          Explore synthetic preview
        </button>
        <Link className="text-link" to="/">
          <ArrowLeft size={16} /> Back to home
        </Link>
      </div>
      <footer>
        Temporal data, with a persistent history.<span>v0.4.0-alpha.3</span>
      </footer>
    </main>
  );
}
const navigation = [
  { path: "", title: "Overview", icon: Home },
  { path: "bci", title: "BCI workspace", icon: Activity },
  { path: "explorer", title: "Explorer", icon: Network },
  { path: "branches", title: "Branches", icon: GitBranch },
  { path: "schema", title: "Schema & migrations", icon: Settings2 },
  { path: "write", title: "Write data", icon: Database },
  { path: "connectors", title: "Connectors", icon: Plug },
  {
    path: "access",
    title: "Connections & keys",
    icon: KeyRound,
  },
  { path: "operations", title: "Operations", icon: Settings2 },
  ...(managedSite
    ? [
        { path: "team", title: "Team & audit", icon: Users },
        { path: "secrets", title: "Secrets", icon: LockKeyhole },
        { path: "apps", title: "Apps", icon: Rocket },
        { path: "security", title: "Account security", icon: ShieldCheck },
      ]
    : []),
];
/** Shown when the account service itself did not answer. */
function AccountUnavailable({ retry }: { retry: () => void }) {
  return (
    <div className="standalone-security">
      <Logo />
      <h2>The account service is not answering.</h2>
      <p>
        Your session is still in this browser and nothing was signed out. Try
        again in a moment.
      </p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
function Console() {
  const { update, connection, managed, refreshManaged } = useAuth(),
    action = useAction(),
    navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebar = (
    <>
      <div>
        <Logo />
      </div>
      <nav aria-label="Console navigation" onClick={() => setMobileOpen(false)}>
        {[
          ["Workspace", ["", "bci", "explorer", "branches"]],
          ["Build", ["schema", "write", "connectors"]],
          ["Manage", ["access", "secrets", "team", "operations", "apps"]],
        ].map(([label, paths]) => {
          const items = navigation
            .filter((n) => paths.includes(n.path))
            .filter(
              (n) =>
                n.path !== "write" || connection?.credential.scope !== "read",
            )
            .filter(
              (n) =>
                !["access", "operations", "team", "secrets", "apps"].includes(
                  n.path,
                ) || connection?.credential.scope === "admin",
            );
          return items.length ? (
            <div key={String(label)}>
              <div className="nav-section">{label}</div>
              {items.map(({ path, title, icon: Icon }) => (
                <NavLink key={path} end={!path} to={`/app/${path}`}>
                  <Icon size={17} strokeWidth={1.6} />
                  {title}
                </NavLink>
              ))}
            </div>
          ) : null;
        })}
      </nav>
      <div className="sidebar-bottom">
        {managedSite && (
          <Link to="/projects">
            <Database size={17} />
            All projects
          </Link>
        )}
        {/* Platform operators only. The server decides this, not the browser. */}
        {managedSite && managed?.superadmin && (
          <Link to="/admin">
            <ShieldCheck size={17} />
            Operator panel
          </Link>
        )}
        <Link
          to={managedSite ? "/documentation/HOSTED" : "/documentation/ISOLATED"}
        >
          <BookOpen size={17} />
          Documentation
        </Link>
        <details className="account-menu">
          <summary>
            <ShieldCheck size={17} />
            Account
            <ChevronDown size={13} />
          </summary>
          <div>
            {managedSite && (
              <Link to="/app/security" onClick={() => setMobileOpen(false)}>
                Account security
              </Link>
            )}
            <button
              className="ghost"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  if (managedSite) await managedApi("/api/auth/sign-out", {});
                  if (!publicSite) update(null);
                  navigate(publicSite ? "/" : "/login");
                })
              }
            >
              <LogOut size={16} />
              {publicSite
                ? "Exit preview"
                : managedSite
                  ? "Sign out"
                  : "Disconnect"}
            </button>
          </div>
        </details>
        {action.feedback}
      </div>
    </>
  );
  return (
    <SchemaProvider synthetic={connection?.edition === "synthetic"}>
      <WorkspaceProvider synthetic={connection?.edition === "synthetic"}>
        <div className="console">
          <aside className="sidebar">{sidebar}</aside>
          <Drawer
            open={mobileOpen}
            onClose={() => setMobileOpen(false)}
            title="Workspace"
            className="mobile-navigation"
          >
            <aside className="sidebar">{sidebar}</aside>
          </Drawer>
          <div className="workspace">
            <div className="workspace-top">
              <button
                className="ghost mobile-menu-button"
                aria-label="Open navigation"
                onClick={() => setMobileOpen(true)}
              >
                <Menu size={20} />
              </button>
              {managedSite ? (
                <select
                  className="project-picker"
                  aria-label="Active project"
                  value={connection?.project?.id || ""}
                  onChange={(e) =>
                    void action.run(async () => {
                      setManagedProject("");
                      await managedApi("/managed/projects/select", {
                        projectId: e.target.value,
                      });
                      await refreshManaged();
                      navigate("/app");
                    })
                  }
                >
                  {managed?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span>
                  Workspace <span className="slash">/</span> Temporal graph
                </span>
              )}
              <BranchPicker />
              {connection?.credential.scope === "admin" && (
                <Link
                  className="button outline connect-action"
                  to="/app/access"
                >
                  Connect
                </Link>
              )}
              <span className="status">
                <i />{" "}
                {connection?.edition === "synthetic"
                  ? "Synthetic preview · no backend"
                  : managedSite
                    ? `${connection?.account?.name} · ${connection?.account?.role}`
                    : `${connection?.credential.scope} token connected`}
              </span>
            </div>
            <main id="main">
              <Routes>
                {managedSite && (
                  <>
                    <Route path="security" element={<ManagedSecurity />} />
                    <Route
                      path="team"
                      element={
                        connection?.credential.scope === "admin" ? (
                          <ManagedTeam />
                        ) : (
                          <Navigate to="/app" replace />
                        )
                      }
                    />
                    <Route
                      path="secrets"
                      element={
                        connection?.credential.scope === "admin" ? (
                          <ManagedSecrets />
                        ) : (
                          <Navigate to="/app" replace />
                        )
                      }
                    />
                    {/* App hosting is administrator-only on the server, so the route is
                        mounted for the same scope the sidebar uses. Hosting switched off is a
                        404 the page itself reports; the server still authorises every call. */}
                    <Route
                      path="apps"
                      element={
                        connection?.credential.scope === "admin" ? (
                          <ManagedApps />
                        ) : (
                          <Navigate to="/app" replace />
                        )
                      }
                    />
                  </>
                )}
                <Route index element={<Overview />} />
                <Route path="bci" element={<BCI />} />
                <Route path="explorer" element={<Explorer />} />
                <Route path="schema" element={<Schema />} />
                <Route path="branches" element={<Branches />} />
                <Route path="connectors" element={<Connectors />} />
                <Route
                  path="write"
                  element={
                    connection?.credential.scope !== "read" ? (
                      <Write />
                    ) : (
                      <Navigate to="/app" replace />
                    )
                  }
                />
                <Route
                  path="access"
                  element={
                    connection?.credential.scope === "admin" ? (
                      <Access />
                    ) : (
                      <Navigate to="/app" replace />
                    )
                  }
                />
                <Route
                  path="operations"
                  element={
                    connection?.credential.scope === "admin" ? (
                      <Operations />
                    ) : (
                      <Navigate to="/app" replace />
                    )
                  }
                />
                <Route path="*" element={<Navigate to="/app" replace />} />
              </Routes>
            </main>
            {managedSite && (
              <footer className="workspace-footer">
                <PolicyLinks />
              </footer>
            )}
          </div>
        </div>
      </WorkspaceProvider>
    </SchemaProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <BrowserRouter basename={import.meta.env.BASE_URL}>
    <App />
  </BrowserRouter>,
);
