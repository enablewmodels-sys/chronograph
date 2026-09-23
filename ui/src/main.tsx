import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
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
import { BranchPicker, WorkspaceProvider } from "./workspace";
const Explorer = lazy(() => import("./Explorer"));
const Overview = lazy(() => import("./Overview"));
const Schema = lazy(() => import("./SchemaWorkspace"));
const Write = lazy(() => import("./Write"));
const Access = lazy(() => import("./Access"));
const Operations = lazy(() => import("./Operations"));
const Documentation = lazy(() => import("./Documentation"));
const Branches = lazy(() => import("./Branches"));
const Connectors = lazy(() => import("./Connectors"));
const ManagedSecurity = lazy(() => import("./ManagedSecurity"));
const ManagedTeam = lazy(() => import("./ManagedTeam"));
const ManagedSecrets = lazy(() => import("./ManagedSecrets"));
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
  const [loadingAccount, setLoadingAccount] = useState(managedSite);
  const refreshManaged = useCallback(async () => {
    setManagedProject("");
    const next = await managedApi<ManagedSession>("/managed/session");
    setManagedProject(next.project?.id || "");
    if (
      next.user &&
      !next.user.needsMfa &&
      next.user.twoFactorEnabled &&
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
    if (managedSite)
      void refreshManaged()
        .catch(() => setManaged(null))
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
                  ) : managed?.user &&
                    !managed.user.needsMfa &&
                    managed.user.twoFactorEnabled ? (
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
              ) : connection ? (
                <Console key={connection.project?.id || "community"} />
              ) : (
                <Navigate
                  to={
                    managed?.user &&
                    !managed.user.needsMfa &&
                    managed.user.twoFactorEnabled
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
        { path: "security", title: "Account security", icon: ShieldCheck },
      ]
    : []),
];
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
          ["Workspace", ["", "explorer", "branches"]],
          ["Build", ["schema", "write", "connectors"]],
          ["Manage", ["access", "secrets", "team", "operations"]],
        ].map(([label, paths]) => {
          const items = navigation
            .filter((n) => paths.includes(n.path))
            .filter(
              (n) =>
                n.path !== "write" || connection?.credential.scope !== "read",
            )
            .filter(
              (n) =>
                !["access", "operations", "team", "secrets"].includes(n.path) ||
                connection?.credential.scope === "admin",
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
                  </>
                )}
                <Route index element={<Overview />} />
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
