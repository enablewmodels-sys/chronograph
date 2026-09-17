import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useState,
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
} from "lucide-react";
import "@fontsource-variable/manrope";
import "./style.css";
import "./theme.css";
import "./schema.css";
import { SchemaProvider } from "./schema-store";
import { api, setToken, useDemo, demoConnection, type Connection } from "./api";
import { Busy, Field, Logo, SubmitForm, useAction } from "./shared";
import Landing from "./Landing";
import { publicSite } from "./site";
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
const AuthContext = createContext<{
  connection: Connection | null;
  update: (s: Connection | null) => void;
}>({ connection: null, update: () => {} });
export const useAuth = () => useContext(AuthContext);
function App() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [pathname]);
  const [connection, setConnection] = useState<Connection | null>(
    publicSite ? demoConnection : null,
  );
  const update = (s: Connection | null) => {
    setConnection(s);
    if (!s) setToken("");
  };
  useEffect(() => {
    const expire = () => update(null);
    window.addEventListener("session-expired", expire);
    return () => {
      window.removeEventListener("session-expired", expire);
    };
  }, []);
  return (
    <AuthContext.Provider value={{ connection, update }}>
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
              connection ? (
                <Navigate to="/app" replace />
              ) : publicSite ? (
                <Navigate to="/" replace />
              ) : (
                <Login />
              )
            }
          />
          <Route path="/documentation/*" element={<Documentation />} />
          <Route
            path="/app/*"
            element={
              connection ? <Console /> : <Navigate to="/login" replace />
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
          Create a token with chronograph-server admin create-token. Read tokens
          can explore; ingest tokens can write; admin tokens manage access and
          backups.
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
  { path: "explorer", title: "Temporal explorer", icon: Network },
  { path: "branches", title: "Branches", icon: GitBranch },
  { path: "schema", title: "Schema & migrations", icon: Settings2 },
  { path: "write", title: "Write data", icon: Database },
  { path: "connectors", title: "Connectors", icon: Plug },
  { path: "access", title: "Agent access", icon: KeyRound },
  { path: "operations", title: "Operations", icon: Settings2 },
];
function Console() {
  const { update, connection } = useAuth(),
    action = useAction(),
    navigate = useNavigate();
  return (
    <SchemaProvider synthetic={connection?.edition === "synthetic"}>
      <WorkspaceProvider synthetic={connection?.edition === "synthetic"}>
        <div className="console">
          <aside className="sidebar">
            <div>
              <Logo />
              <span className="sidebar-caption">Community console</span>
            </div>
            <nav aria-label="Console navigation">
              {navigation
                .filter(
                  (n) =>
                    n.path !== "write" ||
                    connection?.credential.scope !== "read",
                )
                .filter(
                  (n) =>
                    !["access", "operations"].includes(n.path) ||
                    connection?.credential.scope === "admin",
                )
                .map(({ path, title, icon: Icon }) => (
                  <NavLink key={title} end={!path} to={`/app/${path}`}>
                    <Icon size={22} strokeWidth={1.7} />
                    {title}
                  </NavLink>
                ))}
            </nav>
            <div className="sidebar-bottom">
              <Link to="/documentation/QUICKSTART">
                <BookOpen size={22} /> Documentation
              </Link>
              <button
                className="ghost"
                onClick={() =>
                  void action.run(async () => {
                    if (!publicSite) update(null);
                    navigate(publicSite ? "/" : "/login");
                  })
                }
                disabled={action.busy}
              >
                <LogOut size={22} />{" "}
                {publicSite ? "Exit preview" : "Disconnect"}
              </button>
              {action.feedback}
            </div>
          </aside>
          <div className="workspace">
            <div className="workspace-top">
              <span>
                Workspace <span className="slash">/</span> Temporal graph
              </span>
              <BranchPicker />
              <span className="status">
                <i />{" "}
                {connection?.edition === "synthetic"
                  ? "Synthetic preview · no backend"
                  : `${connection?.credential.scope} token connected`}
              </span>
            </div>
            <main id="main">
              <Routes>
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
