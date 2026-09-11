import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { GitBranch, RefreshCw } from "lucide-react";
import { graph } from "./api";

export interface ForkInfo {
  id: string;
  name: string;
  timestamp: string;
  parent_revision: string;
  revision: string;
  inherited_edges: string;
  delta_edges: string;
  new_nodes: string;
  status: "active" | "merged" | "discarded";
  merge: null | {
    parent_revision: string;
    node_mappings: string;
    edge_mappings: string;
  };
}
export interface MergeResult {
  fork: string;
  parent_revision: string;
  nodes: { branch: string; parent: string }[];
  edges: { branch: string; parent: string }[];
}
const Workspace = createContext<{
  fork: string;
  select: (id: string) => void;
  forks: ForkInfo[];
  refresh: () => Promise<void>;
  error: string;
  loading: boolean;
  more: boolean;
}>({
  fork: "",
  select: () => {},
  forks: [],
  refresh: async () => {},
  error: "",
  loading: false,
  more: false,
});
export const useWorkspace = () => useContext(Workspace);
export function workspaceChanged() {
  window.dispatchEvent(new Event("workspace-changed"));
}
export function WorkspaceProvider({
  children,
  synthetic,
}: {
  children: ReactNode;
  synthetic: boolean;
}) {
  const [fork, select] = useState(""),
    [forks, setForks] = useState<ForkInfo[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [more, setMore] = useState(false);
  const refresh = useCallback(async () => {
    if (synthetic) return;
    setLoading(true);
    try {
      const result = await graph<{
        forks: ForkInfo[];
        next_after: string | null;
      }>("forks", { limit: 1000 });
      setForks(result.forks);
      setMore(result.next_after !== null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to read branches.");
    } finally {
      setLoading(false);
    }
  }, [synthetic]);
  useEffect(() => {
    void refresh();
    const changed = () => {
      void refresh();
    };
    window.addEventListener("workspace-changed", changed);
    return () => window.removeEventListener("workspace-changed", changed);
  }, [refresh]);
  return (
    <Workspace.Provider
      value={{ fork, select, forks, refresh, error, loading, more }}
    >
      {children}
    </Workspace.Provider>
  );
}
export function BranchPicker() {
  const { fork, select, forks, refresh, loading, error, more } = useWorkspace();
  return (
    <div className="branch-picker">
      <GitBranch size={16} />
      <select
        aria-label="Working branch"
        value={fork}
        onChange={(e) => select(e.target.value)}
      >
        <option value="">Main</option>
        {forks
          .filter((f) => f.status === "active" || f.id === fork)
          .map((f) => (
            <option value={f.id} key={f.id}>
              {f.name}
              {f.status !== "active" ? ` · ${f.status}` : ""}
            </option>
          ))}
        {fork && !forks.some((f) => f.id === fork) && (
          <option value={fork}>Branch {fork}</option>
        )}
      </select>
      <button
        className="ghost"
        aria-label="Refresh branches"
        onClick={() => void refresh()}
        disabled={loading}
      >
        <RefreshCw size={14} />
      </button>
      {(error || more) && (
        <span role="status" className="branch-picker-note">
          {error || "First 1,000 branches; use the API for older/later pages."}
        </span>
      )}
    </div>
  );
}
