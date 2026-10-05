#!/usr/bin/env node
/**
 * Run a real Managed deployment on this machine.
 *
 * WHY this exists: the console's behaviour under a real control plane and a real engine is the
 * thing that keeps breaking (a page that renders fine against a mock can still blank out on a
 * payload the server really sends, and the hosted sign-in, session and /admin paths cannot be
 * mocked at all). This boots the same code the host runs -- control-plane/gateway.mjs over
 * target/release/chronograph-server, serving ui/dist-managed -- on 127.0.0.1, with one owner
 * account and one project whose data is seeded so lists are not empty.
 *
 * Usage:
 *   node scripts/managed-local.mjs [--port 19090] [--ui ui/dist-managed] [--data DIR]
 *
 * It prints the console URL, the owner email and the path of a 0600 file holding the generated
 * password (never the password itself, so it does not land in a log or a transcript). Sign in
 * with email + password at /login. Ctrl-C stops the deployment and removes the temporary state
 * unless --data was given.
 */
import { execFile, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../launch/private/managed/control-plane/gateway.mjs";
import { loadConfig } from "../launch/private/managed/control-plane/config.mjs";
import { random } from "../launch/private/managed/control-plane/store.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const flag = (name, fallback) => {
  const i = process.argv.indexOf("--" + name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PORT = Number(flag("port", "19090"));
const ENGINE_PORT = PORT + 1;
const UI = resolve(root, flag("ui", "ui/dist-managed"));
const BINARY = resolve(root, flag("binary", "target/release/chronograph-server"));
const OWNER = (flag("email", "operator@chronodb.local") || "").toLowerCase();
const PRIMARY = "primary";

const state = flag("data", "") ? resolve(flag("data")) : await mkdtemp(join(tmpdir(), "chronodb-local-"));
const keep = Boolean(flag("data", ""));
await mkdir(join(state, "engine", "config"), { recursive: true });

// --- a real engine, with real tokens, exactly as a project's own engine is provisioned -----
const engineRoot = join(state, "engine");
const tokenFiles = {};
for (const scope of ["admin", "ingest", "read"]) {
  const file = join(engineRoot, "config", scope + ".token");
  // create-token refuses to overwrite, and re-using --data is the normal way to keep a local
  // deployment between runs, so an existing token is left alone.
  try {
    await readFile(file);
    tokenFiles[scope] = file;
    continue;
  } catch {
    /* not created yet */
  }
  await new Promise((done, fail) =>
    execFile(
      BINARY,
      ["admin", "create-token", "Local " + scope + " bridge", scope, "365", file],
      { env: { ...process.env, CHRONOGRAPH_AUTH: join(engineRoot, "config", "auth.json") } },
      (error) => (error ? fail(error) : done()),
    ),
  );
  tokenFiles[scope] = file;
}
const admin = (await readFile(tokenFiles.admin, "utf8")).trim();
const engine = spawn(BINARY, ["serve"], {
  env: {
    ...process.env,
    CHRONOGRAPH_AUTH: join(engineRoot, "config", "auth.json"),
    CHRONOGRAPH_DATA: join(engineRoot, "data"),
    CHRONOGRAPH_BIND: "127.0.0.1:" + ENGINE_PORT,
    CHRONOGRAPH_ORIGIN: "http://127.0.0.1:" + PORT,
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const engineUrl = "http://127.0.0.1:" + ENGINE_PORT;
/**
 * A port already in use is the common way this script fails, and the failure it used to
 * produce was a bare "the engine exited during start-up" with a temporary directory left
 * behind. Name the likely cause, clean up, and exit.
 */
const abort = async (message) => {
  engine.kill("SIGKILL");
  if (!keep) await rm(state, { recursive: true, force: true });
  process.stderr.write(
    message +
      "\nAnother local deployment is probably still running: stop it (pkill -f managed-local.mjs) or pass --port.\n",
  );
  process.exit(1);
};
let ready = false;
for (let i = 0; i < 200; i++) {
  if (engine.exitCode !== null)
    await abort(
      "The engine exited during start-up, most often because " + engineUrl + " is taken.",
    );
  // The engine authorises every request by public origin, so even the readiness probe has
  // to present the deployment's host rather than the port the engine listens on. fetch()
  // cannot set Host, and without it this probe answers 403 forever.
  const status = await new Promise((done) => {
    const probe = httpRequest(
      {
        host: "127.0.0.1",
        port: ENGINE_PORT,
        path: "/healthz",
        method: "GET",
        headers: { host: "127.0.0.1:" + PORT },
        timeout: 1000,
      },
      (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      },
    );
    probe.on("error", () => done(0));
    probe.on("timeout", () => {
      probe.destroy();
      done(0);
    });
    probe.end();
  });
  if (status === 200) {
    ready = true;
    break;
  }
  await new Promise((done) => setTimeout(done, 100));
}
if (!ready) await abort("The engine did not become ready.");
// The engine authorises by public origin, so a direct call has to present the origin the
// deployment is configured with rather than the port the engine happens to use. fetch()
// silently drops a Host header (it is a forbidden header name), so this goes through
// node:http, which does not.
const op = (path, body) =>
  new Promise((done, fail) => {
    const payload = JSON.stringify(body ?? {});
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: ENGINE_PORT,
        path: "/v1/" + path,
        method: "POST",
        headers: {
          authorization: "Bearer " + admin,
          "content-type": "application/json",
          host: "127.0.0.1:" + PORT,
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => done(response.statusCode));
      },
    );
    request.on("error", fail);
    request.end(payload);
  });

// --- the control plane's own configuration file, through the real loader -------------------
const secretFile = join(state, "session.secret");
await writeFile(secretFile, random(), { mode: 0o600 });
const configPath = join(state, "control.json");
await writeFile(
  configPath,
  JSON.stringify({
    origin: "http://127.0.0.1:" + PORT,
    port: PORT,
    database: join(state, "identity.sqlite"),
    secretFile,
    tokenFiles,
    projectsRoot: join(state, "projects"),
    upstream: engineUrl,
    maxProjects: 3,
    projectPortStart: ENGINE_PORT + 10,
    binary: BINARY,
    ui: UI,
    docs: join(root, "docs"),
    ownerEmail: OWNER,
    superadminEmails: [OWNER],
    // A development volume is legitimately small. The production default of 5 GiB would refuse
    // every write on a nearly full laptop, which is how a working control plane looks broken.
    minimumFreeBytes: 256 * 1024 ** 2,
  }),
  { mode: 0o600 },
);
const config = await loadConfig(configPath);
const app = await createGateway(config);
await app.projects.restore();

// One project, backed by the engine started above. external: 1 is what tells the control plane
// to route /v1 for it to config.upstream instead of spawning another engine.
app.db
  .prepare(
    "INSERT OR REPLACE INTO cg_project (id,name,owner_id,state,created_at,external) VALUES (?,?,?,?,?,?)",
  )
  .run(PRIMARY, "Local project", "operator", "ready", Date.now(), 1);

/**
 * The engine's readiness probe cannot tell our engine from one already running: a second
 * deployment is started with the same origin, so the probe of the deployment already on the
 * port answers 200 for the port the newcomer wanted. The listen that then fails is this one,
 * and it used to surface as a raw EADDRINUSE stack with the temporary state left behind.
 */
app.server.on("error", (error) => {
  void abort(
    error.code === "EADDRINUSE"
      ? "Port " + PORT + " is already serving a deployment."
      : "The console could not start: " + error.message,
  );
});
app.server.listen(PORT, "127.0.0.1");
await new Promise((done, fail) => {
  app.server.once("listening", done);
  app.server.once("error", fail);
}).catch(() => {
  /* abort() above already reported it and exited */
});

// --- an owner who can sign in with a password, the way an invited operator does -------------
// Between 15 and 128 characters, which is what the identity provider accepts.
const password = "local-" + random().slice(0, 32);
// Re-running against existing --data finds the account already there; the recoverable path
// is the same one the deployment's bootstrap-owner command uses.
const existing = app.db.prepare("SELECT id FROM user WHERE email=?").get(OWNER);
const invite = await app.issueInvite({
  email: OWNER,
  name: "Local operator",
  role: "owner",
  projectId: PRIMARY,
  reset: Boolean(existing),
});
const token = new URLSearchParams(new URL(invite.url).hash.slice(1)).get("token");
const call = (path, body) =>
  fetch("http://127.0.0.1:" + PORT + path, {
    method: "POST",
    // The identity provider rejects a cookie-flow POST without a same-origin Origin header,
    // which is exactly what a browser sends and what a bare fetch does not.
    headers: {
      "content-type": "application/json",
      "x-real-ip": "127.0.0.1",
      origin: "http://127.0.0.1:" + PORT,
    },
    body: JSON.stringify(body),
  });
const reset = await call("/api/auth/reset-password", { token, newPassword: password });
if (reset.status !== 200) throw new Error("could not set the local password: " + (await reset.text()));
const passwordFile = join(state, "owner-password");
await writeFile(passwordFile, password + "\n", { mode: 0o600 });

// --- data, so that the console has something to draw ---------------------------------------
// One at a time: a burst of writes on a journal that is still settling is refused, and the
// point of the seed is data the console can draw, not a load test.
const seeded = [];
for (const [name, body] of [
  ["add_edges", {
    durability: "fsync",
    edges: [
      { src: "1", dst: "2", kind: 1, valid_from: "10" },
      { src: "2", dst: "3", kind: 2, valid_from: "20" },
      { src: "3", dst: "4", kind: 3, valid_from: "30" },
    ],
  }],
  ["add_node", { id: "5", durability: "fsync" }],
  ["fork", { t: "40", name: "experiment" }],
  ["load_demo", {}],
  ["sync", {}],
]) {
  let status = await op(name, body);
  for (let retry = 0; retry < 3 && status >= 500; retry++) {
    await new Promise((done) => setTimeout(done, 500));
    status = await op(name, body);
  }
  seeded.push(name + ":" + status);
}

process.stdout.write(
  JSON.stringify(
    {
      console: "http://127.0.0.1:" + PORT + "/login",
      email: OWNER,
      passwordFile,
      project: PRIMARY,
      engine: engineUrl,
      ui: UI,
      state,
      seed: seeded,
    },
    null,
    1,
  ) + "\n",
);

const stop = async () => {
  engine.kill("SIGTERM");
  app.server.close();
  try {
    await app.projects.close();
  } catch {
    /* nothing spawned */
  }
  if (!keep) await rm(state, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
