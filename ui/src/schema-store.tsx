import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Binding } from "./ConnectorPresets";
import { graph } from "./api";

export type PropertyType =
  "bool" | "u32" | "i32" | "u64" | "i64" | "f32" | "f64";
export type Property = { name: string; type: PropertyType; offset: number };
export type Relation = {
  payload_encoding?: "inline" | "arrow_record_v1";
  kind: number;
  name: string;
  description: string;
  source_label: string;
  target_label: string;
  properties: Property[];
};
export type Settings = {
  name: string;
  description: string;
  default_durability: "buffered" | "fsync";
  default_query_limit: number;
  strict_relations: boolean;
};
export type Snapshot = {
  settings: Settings;
  relations: Relation[];
  connectors?: Binding[];
};
export type MigrationRecord = {
  id: string;
  name: string;
  checksum: string;
  applied_at: number;
  revision: number;
  operations: number;
};
export type Catalog = Snapshot & {
  revision: number;
  history: MigrationRecord[];
};
export const sizes: Record<PropertyType, number> = {
  bool: 1,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f32: 4,
  f64: 8,
};
const SchemaContext = createContext<{
  catalog: Catalog | null;
  error: string;
  refresh: () => Promise<void>;
}>({ catalog: null, error: "", refresh: async () => {} });
export function SchemaProvider({
  children,
  synthetic,
}: {
  children: ReactNode;
  synthetic: boolean;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const result = synthetic
        ? {
            revision: 0,
            history: [],
            relations: [],
            settings: {
              name: "Synthetic preview",
              description: "Connect a workspace to define a schema.",
              default_durability: "buffered" as const,
              default_query_limit: 100,
              strict_relations: false,
            },
          }
        : await graph<Catalog>("schema");
      setCatalog(result);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load schema");
      throw e;
    }
  }, [synthetic]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  return (
    <SchemaContext.Provider value={{ catalog, error, refresh }}>
      {children}
    </SchemaContext.Provider>
  );
}
export const useSchema = () => useContext(SchemaContext);
export function migrationSource(operations: unknown[], name: string) {
  return JSON.stringify(
    {
      version: JSON.stringify(operations).includes("arrow_record_v1") ? 2 : 1,
      id: `${new Date().toISOString().replace(/[^0-9]/g, "")}_${crypto.randomUUID().slice(0, 8)}`,
      name,
      operations,
    },
    null,
    2,
  );
}
export function saveJson(source: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([source], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
