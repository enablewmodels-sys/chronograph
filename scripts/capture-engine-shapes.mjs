#!/usr/bin/env node
/**
 * Capture the engine's real response shape for every operation the console calls.
 *
 * WHY a capture rather than hand-written fixtures: the console sweep used to invent payloads,
 * and an invented payload that the server never sends tests the invention, not the console. A
 * page that crashed on it looked like a page bug and a page that survived proved nothing. Here
 * the shapes come from a real chronograph-server: the script boots one over a temporary data
 * directory, seeds a little data so lists are not empty, calls each operation, and writes what
 * came back to ui/e2e/fixtures/engine.json. The sweep replays those exact bodies.
 *
 * Run with: node scripts/capture-engine-shapes.mjs [--profile target/release]
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argProfile = process.argv.indexOf("--profile");
const profile = argProfile === -1 ? "target/release" : process.argv[argProfile + 1];
const binary = join(root, profile, "chronograph-server");
const output = join(root, "ui/e2e/fixtures/engine.json");

// Every operation the console can call, with a body that a page would send. The point is the
// shape of the answer, so the body only has to be well formed.
// Field names here are the engine's, taken from the rejections it prints for a wrong
// guess ("unknown field `query`, expected one of `fork`,`mode`,..."), and identifiers
// and timestamps are decimal strings because that is what the store accepts.
const OPS = [
  ["GET", "/v1/info", undefined],
  ["GET", "/v1/tokens", undefined],
  ["GET", "/v1/backups", undefined],
  ["GET", "/v1/metrics", undefined],
  ["POST", "/v1/stats", {}],
  ["POST", "/v1/schema", {}],
  ["POST", "/v1/forks", { limit: 1000 }],
  ["POST", "/v1/query", { mode: "as_of", t: "30", limit: 5 }],
  ["POST", "/v1/tokens", {}],
  ["POST", "/v1/backups", {}],
  ["POST", "/v1/sync", {}],
  ["POST", "/v1/load_demo", {}],
  ["POST", "/v1/add_node", { id: "9001", durability: "fsync" }],
  ["POST", "/v1/add_edges", {
    durability: "fsync",
    edges: [{ src: "9001", dst: "9002", kind: 1, valid_from: "10" }],
  }],
  ["POST", "/v1/invalidate_edge", { id: "1", t: "20", durability: "fsync" }],
  ["POST", "/v1/fork", { t: "30", name: "experiment" }],
  ["POST", "/v1/merge", { fork: "1" }],
  ["POST", "/v1/discard", { fork: "1" }],
  ["POST", "/v1/schema_preview", { source: "{}" }],
  ["POST", "/v1/schema_apply", { source: "{}" }],
  ["POST", "/v1/schema_export", {}],
  ["POST", "/v1/schema_rollback", { revision: "1" }],
  ["POST", "/v1/connector_catalog", {}],
  ["POST", "/v1/connector_template", { connector: "bci" }],
  ["POST", "/v1/connector_record", { id: "bci" }],
  ["POST", "/v1/connector_ingest", { connector: "bci" }],
  ["POST", "/v1/connector_checkpoint", { connector: "bci" }],
  ["POST", "/v1/asset_put", { version: "1", metadata: {}, data_hex: "00" }],
  ["POST", "/v1/asset_get", { asset: "1" }],
  ["POST", "/v1/bci_sessions", { limit: 5 }],
  ["POST", "/v1/bci_session", { session: "1" }],
  ["POST", "/v1/bci_records", { session: "1", limit: 5 }],
  ["POST", "/v1/bci_window", { session: "1" }],
  ["POST", "/v1/bci_manifest", { sessions: ["1"] }],
];

const base = await mkdtemp(join(tmpdir(), "chronograph-shapes-"));
const data = join(base, "data");
await mkdir(data, { recursive: true });
const auth = join(base, "auth.json");
const tokenFile = join(base, "admin.token");
execFileSync(binary, ["admin", "create-token", "shape capture", "admin", "1", tokenFile], {
  env: { ...process.env, CHRONOGRAPH_AUTH: auth },
  stdio: ["ignore", "pipe", "pipe"],
});
const token = (await readFile(tokenFile, "utf8")).trim();
const port = 18711;
const child = execFileSync; // eslint-disable-line no-unused-expressions
const { spawn } = await import("node:child_process");
const server = spawn(binary, ["serve"], {
  env: {
    ...process.env,
    CHRONOGRAPH_DATA: data,
    CHRONOGRAPH_AUTH: auth,
    CHRONOGRAPH_BIND: `127.0.0.1:${port}`,
    CHRONOGRAPH_ORIGIN: `http://127.0.0.1:${port}`,
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let log = "";
server.stderr.on("data", chunk => (log += chunk));
const url = `http://127.0.0.1:${port}`;
for (let i = 0; i < 200; i++) {
  if (server.exitCode !== null) throw new Error(`server exited: ${log}`);
  try {
    if ((await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(250) })).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise(done => setTimeout(done, 100));
}

const call = async (method, path, body) => {
  const response = await fetch(url + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    value = { unparsed: text.slice(0, 400) };
  }
  return { status: response.status, body: value };
};

// A little data, so that list shapes are real lists with an entry rather than empty arrays.
const seed = [];
seed.push(await call("POST", "/v1/add_edges", {
  durability: "fsync",
  edges: [
    { src: "1", dst: "2", kind: 1, valid_from: "10" },
    { src: "2", dst: "3", kind: 2, valid_from: "20" },
  ],
}));
seed.push(await call("POST", "/v1/fork", { t: "30", name: "experiment" }));
seed.push(await call("POST", "/v1/load_demo", {}));
seed.push(await call("POST", "/v1/schema_apply", {
  source: JSON.stringify({
    version: 3,
    relations: [
      {
        kind: 1,
        name: "observed_by",
        source: "signal",
        target: "decoder",
        properties: [],
      },
    ],
    settings: { name: "Primary" },
  }),
}));

const captured = { generated: { binary: profile, seed: seed.map(s => s.status) }, routes: {} };
for (const [method, path, body] of OPS) {
  captured.routes[`${method} ${path}`] = await call(method, path, body);
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, JSON.stringify(captured, null, 2) + "\n");
server.kill("SIGTERM");
await rm(base, { recursive: true, force: true });
const statuses = Object.entries(captured.routes).map(([k, v]) => `${k} ${v.status}`);
process.stdout.write(JSON.stringify({ output, calls: statuses.length, statuses }) + "\n");
