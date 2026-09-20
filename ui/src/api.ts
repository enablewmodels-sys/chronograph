import { managedSite, publicSite } from "./site";
import {
  projectHeaders,
  type ManagedUser,
  type ManagedProject,
} from "./managed-api";

export interface Edge {
  id: string;
  src: string;
  dst: string;
  kind: number;
  valid_from: string;
  valid_to: string;
  payload: string;
  relation?: string;
  properties?: Record<string, string | number | boolean>;
  schema_error?: string;
}
export interface Stats {
  nodes: string;
  edge_versions: string;
  log_bytes: string;
  recovered_tail_bytes: string;
  default_durability: string;
  require_fsync?: boolean;
  writer_healthy?: boolean;
  revision: string;
  parent_revision?: string;
  active_forks?: string;
  duration_ms: number | null;
}
export interface Connection {
  require_fsync?: boolean;
  credential: { id: string; scope: "read" | "ingest" | "admin" };
  edition: "community" | "managed" | "synthetic";
  mcp_url: string;
  uptime_seconds: number;
  account?: ManagedUser;
  project?: ManagedProject;
  api_url?: string;
}
export interface QueryResult {
  edges: Edge[];
  count: number;
  next_cursor: string | null;
  duration_ms: number | null;
  mode: string;
}
let token = "";
let demo = publicSite;
export function setToken(value: string) {
  if (publicSite) {
    if (value) throw new Error("The public demo does not accept API tokens.");
    token = "";
    demo = true;
    return;
  }
  token = value;
  demo = false;
}
export function useDemo() {
  token = "";
  demo = true;
}
export const demoConnection: Connection = {
  credential: { id: "synthetic", scope: "read" },
  edition: "synthetic",
  mcp_url: "",
  uptime_seconds: 0,
};
export async function request(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<Response> {
  if (demo && path.startsWith("/v1/")) {
    const { demoRequest } = await import("./demo");
    return new Response(JSON.stringify(demoRequest(path, data)), {
      headers: { "content-type": "application/json" },
    });
  }
  if (publicSite)
    throw new Error("The public demo cannot call a database API.");
  const response = await fetch(path, {
    method,
    credentials: managedSite ? "same-origin" : "omit",
    headers: {
      ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(managedSite ? projectHeaders() : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("session-expired"));
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error?.message || text;
    } catch {
      /* Plain extractor errors are useful too. */
    }
    throw new Error(message || `Request failed (${response.status})`);
  }
  return response;
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  return (await request(path, method, data)).json();
}
export function graph<T>(op: string, args: unknown = {}): Promise<T> {
  const write = [
    "add_edges",
    "add_node",
    "invalidate_edge",
    "load_demo",
    "fork",
    "merge",
    "discard",
  ].includes(op);
  return api(
    `/v1/${op}`,
    "POST",
    write ? { ...(args as object), durability: "fsync" } : args,
  );
}
export async function download(path: string, filename: string, data?: unknown) {
  const response = await request(
    path,
    data === undefined ? "GET" : "POST",
    data,
  );
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const endTime = (s: string) =>
  s === "9223372036854775807" ? "Open" : s;
export const bytes = (s: string) => {
  const n = Number(s);
  return n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KiB`
      : `${(n / 1048576).toFixed(1)} MiB`;
};
