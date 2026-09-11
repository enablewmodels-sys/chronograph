import type { Edge } from "./api";
const pairs = [
  [1001, 1002, 1],
  [1001, 1005, 2],
  [1005, 1003, 3],
  [1005, 1004, 1],
  [1006, 1005, 1],
  [1005, 1007, 4],
  [1005, 1008, 2],
  [1002, 1008, 3],
];
const edges: Edge[] = Array.from({ length: 40 }, (_, i) => {
  const tick = Math.floor(i / 8),
    [src, dst, kind] = pairs[i % 8];
  return {
    id: String(i),
    src: String(src),
    dst: String(dst),
    kind,
    valid_from: String(tick * 1000000),
    valid_to: tick === 4 ? "9223372036854775807" : String((tick + 1) * 1000000),
    payload: tick.toString(16).padStart(2, "0").repeat(16),
  };
});
/** Explicit synthetic preview; no credentials, persistence, or measured latency. */
export function demoRequest(path: string, input: unknown): unknown {
  if (path === "/v1/stats")
    return {
      nodes: "8",
      edge_versions: "40",
      log_bytes: "0",
      recovered_tail_bytes: "0",
      revision: "0",
      default_durability: "In-memory preview",
      duration_ms: null,
    };
  if (path !== "/v1/query")
    throw new Error(
      "Synthetic preview is read-only. Connect to a local service for this operation.",
    );
  const q = input as Record<string, string | number | null>;
  const mode = String(q.mode ?? "as_of"),
    t = BigInt(q.t ?? "0"),
    start = BigInt(q.start ?? "0"),
    end = BigInt(q.end ?? "9223372036854775807");
  const limit = Number(q.limit ?? 100);
  if (limit < 1 || limit > 1000) throw new Error("Page limit must be 1–1000");
  let rows = edges.filter(
    (e) =>
      mode === "history" ||
      (mode === "between"
        ? BigInt(e.valid_from) < end && BigInt(e.valid_to) > start
        : BigInt(e.valid_from) <= t && t < BigInt(e.valid_to)),
  );
  if (mode === "neighbors" || mode === "sample")
    rows = rows.filter((e) => e.src === String(q.node));
  if (mode === "sample") {
    if (q.strategy === "uniform")
      throw new Error(
        "Seeded uniform sampling requires the engine. Use Latest first in the synthetic preview.",
      );
    rows = [...rows]
      .sort((a, b) => Number(BigInt(b.valid_from) - BigInt(a.valid_from)))
      .slice(0, Number(q.k ?? 10));
  }
  const offset = q.cursor ? Number(String(q.cursor).split(":")[1]) : 0,
    page = rows.slice(offset, offset + limit);
  return {
    edges: page,
    count: page.length,
    next_cursor: offset + limit < rows.length ? `demo:${offset + limit}` : null,
    duration_ms: null,
    mode,
    revision: "0",
  };
}
