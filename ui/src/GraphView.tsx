import { useId, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import type { Edge } from "./api";
export type GraphSelection = { type: "node" | "edge"; id: string };
export function GraphView({
  edges,
  illustration = false,
  selection,
  onSelect,
}: {
  edges: Edge[];
  illustration?: boolean;
  selection?: GraphSelection | null;
  onSelect?: (value: GraphSelection | null) => void;
}) {
  const marker = useId().replace(/[^a-zA-Z0-9_-]/g, ""),
    [local, setLocal] = useState<GraphSelection | null>(null),
    [zoom, setZoom] = useState(1),
    [layout, setLayout] = useState("network");
  const chosen = selection === undefined ? local : selection;
  const choose = (value: GraphSelection | null) => {
    setLocal(value);
    onSelect?.(value);
  };
  const nodes = [...new Set(edges.flatMap((e) => [e.src, e.dst]))].slice(0, 40);
  const fixed = [
    [100, 90],
    [315, 90],
    [320, 285],
    [545, 110],
    [635, 270],
    [100, 300],
    [475, 365],
    [670, 385],
  ];
  let positions = new Map(
    nodes.map((n, i) => [
      n,
      nodes.length <= 8
        ? fixed[i]
        : [
            380 + 300 * Math.cos((i * Math.PI * 2) / nodes.length),
            230 + 165 * Math.sin((i * Math.PI * 2) / nodes.length),
          ],
    ]),
  );
  let height = 450;
  if (layout === "tree") {
    const included = new Set(nodes);
    const links = edges.filter(
      (e) => included.has(e.src) && included.has(e.dst),
    );
    const children = new Map<string, string[]>();
    for (const edge of links)
      children.set(edge.src, [...(children.get(edge.src) || []), edge.dst]);
    const destinations = new Set(links.map((e) => e.dst));
    const levels = new Map<string, number>();
    const roots = [...nodes.filter((n) => !destinations.has(n)), ...nodes];
    for (const root of roots) {
      if (levels.has(root)) continue;
      levels.set(root, 0);
      const queue = [root];
      for (let index = 0; index < queue.length; index++) {
        const parent = queue[index];
        for (const child of children.get(parent) || []) {
          if (levels.has(child)) continue;
          levels.set(child, levels.get(parent)! + 1);
          queue.push(child);
        }
      }
    }
    const depth = Math.max(0, ...levels.values());
    height = Math.max(450, (depth + 1) * 85 + 80);
    positions = new Map(
      nodes.map((n) => {
        const level = levels.get(n)!;
        const row = nodes.filter((id) => levels.get(id) === level);
        return [
          n,
          [
            45 + ((row.indexOf(n) + 1) * 670) / (row.length + 1),
            65 + (level * (height - 130)) / Math.max(1, depth),
          ],
        ];
      }),
    );
  }
  const visible = edges
    .filter((e) => positions.has(e.src) && positions.has(e.dst))
    .slice(0, 80);
  if (!nodes.length)
    return (
      <div className="graph-empty">
        <span className="empty-orbit">○</span>
        <h3>No relationships in this view</h3>
        <p>
          Choose another time, write an edge, or load the sample from Overview.
        </p>
      </div>
    );
  return (
    <div className={`graph-view ${layout === "tree" ? "tree-layout" : ""}`}>
      <div className="graph-tools">
        <span className="scope-badge">
          {illustration
            ? "Illustrative scene"
            : `${nodes.length} nodes · ${visible.length} edges`}
        </span>
        <div>
          {!illustration && (
            <select
              aria-label="Graph layout"
              value={layout}
              onChange={(e) => {
                setLayout(e.target.value);
                setZoom(1);
              }}
            >
              <option value="network">Graph layout</option>
              <option value="tree">Tree layout</option>
            </select>
          )}
          <button
            className="ghost"
            aria-label="Zoom out graph"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          >
            <Minus size={14} />
          </button>
          <button
            className="ghost"
            aria-label="Zoom in graph"
            disabled={zoom >= 2}
            onClick={() => setZoom((z) => Math.min(2, z + 0.25))}
          >
            <Plus size={14} />
          </button>
          <button
            className="ghost"
            aria-label="Reset graph view"
            onClick={() => {
              setZoom(1);
              choose(null);
            }}
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>
      <svg
        viewBox={`${380 - 380 / zoom} ${height / 2 - height / 2 / zoom} ${760 / zoom} ${height / zoom}`}
        height={height}
        role="img"
        aria-label={
          illustration
            ? "Illustrative temporal graph"
            : `${layout === "tree" ? "Tree" : "Graph"} preview: ${nodes.length} nodes and ${visible.length} relationships`
        }
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {visible.map((e, i) => {
          const [x1, y1] = positions.get(e.src)!,
            [x2, y2] = positions.get(e.dst)!,
            dx = x2 - x1,
            dy = y2 - y1,
            length = Math.hypot(dx, dy) || 1,
            padding = 26;
          const d =
            e.src === e.dst
              ? `M ${x1 - 12} ${y1 - 16} c -60 -80 85 -80 25 0`
              : `M ${x1 + (dx / length) * padding} ${y1 + (dy / length) * padding} Q ${(x1 + x2) / 2 - (dy / length) * ((i % 3) - 1) * 13} ${(y1 + y2) / 2 + (dx / length) * ((i % 3) - 1) * 13} ${x2 - (dx / length) * padding} ${y2 - (dy / length) * padding}`;
          const active = chosen?.type === "edge" && chosen.id === e.id,
            faded =
              chosen?.type === "node" &&
              e.src !== chosen.id &&
              e.dst !== chosen.id;
          return (
            <g
              key={e.id}
              className={`graph-edge ${active ? "selected-edge" : ""} ${faded ? "muted-edge" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`Inspect relationship ${e.id}`}
              onClick={() => choose({ type: "edge", id: e.id })}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose({ type: "edge", id: e.id });
                }
              }}
            >
              <path d={d} className="edge-hit" />
              <path d={d} className="edge-line" markerEnd={`url(#${marker})`} />
              {nodes.length <= 12 && (
                <text
                  x={(x1 + x2) / 2}
                  y={(y1 + y2) / 2 - 9}
                  className="edge-label"
                >
                  {e.relation || `kind ${e.kind}`}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n, i) => {
          const [x, y] = positions.get(n)!,
            selected = chosen?.type === "node" && chosen.id === n;
          return (
            <g
              key={n}
              className={`graph-node node-tone-${i % 4}`}
              role="button"
              tabIndex={0}
              aria-label={`Inspect node ${n}`}
              onClick={() => choose(selected ? null : { type: "node", id: n })}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  choose({ type: "node", id: n });
                }
              }}
            >
              <circle
                cx={x}
                cy={y}
                r={nodes.length > 15 ? 14 : 25}
                className={selected ? "selected-node" : ""}
              />
              {nodes.length <= 15 && (
                <circle cx={x} cy={y} r="5" className="node-center" />
              )}
              <text x={x} y={y + 44}>
                {n}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="graph-caption">
        {chosen
          ? `${chosen.type === "node" ? "Node" : "Relationship"} ${chosen.id} selected`
          : "Select a node or relationship to inspect this result page."}
      </div>
      {(edges.length > 80 ||
        new Set(edges.flatMap((e) => [e.src, e.dst])).size > 40) && (
        <p className="small muted">
          Graph preview limited to 40 nodes and 80 edges. The table contains the
          queried page.
        </p>
      )}
    </div>
  );
}
