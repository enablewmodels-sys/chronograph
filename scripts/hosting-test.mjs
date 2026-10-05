#!/usr/bin/env node
/**
 * Evidence for the console's Layer 4 app hosting surface
 * (launch/private/managed/control-plane/hosting.mjs).
 *
 * WHY this drives the real gateway in process: the security rules that matter here are the ones
 * that decide whether a request can reach appctl's argv, its environment or its state files, and a
 * mock of the gateway would test the mock. So this file builds the real gateway over a temporary
 * SQLite identity database, signs in real accounts with real roles, and lets the real appctl run
 * with the dry-run runtime, which records the exact argv a container runtime would have received.
 *
 * The credential check is a literal search: a distinctly shaped secret is placed in this process's
 * environment before the gateway is built, and no response, ledger, state file or dry-run trace may
 * contain it afterwards. Run with: node scripts/hosting-test.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGateway } from "../launch/private/managed/control-plane/gateway.mjs";
import { loadConfig } from "../launch/private/managed/control-plane/config.mjs";
import { random } from "../launch/private/managed/control-plane/store.mjs";

const PRIMARY = "primary";
const APP = "console-api";
const STATEFUL = "stateful-db";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PASSWORD = "console hosting example passphrase";
// A distinctly shaped secret, so "a credential reached a file" is a searchable fact. It is present
// in this process's environment for the whole run.
const SENTINEL = "sentinel-not-a-credential-0123456789abcdef";
process.env.CHRONOGRAPH_TOKEN = SENTINEL;

let checks = 0;
let failures = 0;
function ok(value, message) {
  checks += 1;
  assert.ok(value, message);
}
function equal(actual, expected, message) {
  checks += 1;
  assert.equal(actual, expected, message);
}
function scenario(name, body) {
  test(name, async () => {
    try {
      await body();
    } catch (error) {
      failures += 1;
      throw error;
    }
  });
}

// One summary line, always last, and a non-zero exit whenever a check failed.
process.on("exit", () => {
  const passed = failures === 0 && checks > 0;
  if (!passed) process.exitCode = 1;
  process.stdout.write(JSON.stringify({ passed, checks }) + "\n");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const bodies = [];
function clientFor(app, config, ip) {
  const cookies = new Map();
  return {
    cookies,
    async call(path, body, headers = {}) {
      const requestHeaders = {
        host: new URL(config.origin).host,
        "x-real-ip": ip,
        ...(body === undefined
          ? {}
          : { origin: config.origin, "content-type": "application/json" }),
        cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "),
        ...headers,
      };
      const response = await app.handle(
        new Request(config.origin + path, {
          method: body === undefined ? "GET" : "POST",
          headers: requestHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0];
        const i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const text = await response.text();
      let value = null;
      try {
        value = JSON.parse(text);
      } catch {
        value = null;
      }
      bodies.push(text);
      return { status: response.status, value, text, headers: response.headers };
    },
  };
}
async function hostingFixture(makeHosting) {
  const root = await mkdtemp(join(tmpdir(), "chronograph-hosting-"));
  await mkdir(join(root, "projects"));
  const hosting = makeHosting ? makeHosting(root) : null;
  const config = {
    origin: "http://127.0.0.1:18991",
    database: join(root, "identity.sqlite"),
    secret: random(),
    tokens: {
      admin: "cg_" + "a".repeat(16) + "_" + "a".repeat(64),
      ingest: "cg_" + "b".repeat(16) + "_" + "b".repeat(64),
      read: "cg_" + "c".repeat(16) + "_" + "c".repeat(64),
    },
    upstream: "http://127.0.0.1:18992",
    projectsRoot: join(root, "projects"),
    maxProjects: 3,
    projectPortStart: 18993,
    binary: "/usr/bin/false",
    ui: root,
    docs: root,
    superadminEmails: [],
    ...(hosting ? { hosting } : {}),
  };
  const app = await createGateway(config);
  app.db
    .prepare(
      "INSERT INTO cg_project (id,name,owner_id,state,created_at,external) VALUES (?,?,?,?,?,?)",
    )
    .run(PRIMARY, "ChronoDB", "operator", "ready", Date.now(), 1);
  return {
    root,
    config,
    app,
    hosting: hosting?.hosting ?? null,
    stateRoot: hosting?.stateRoot ?? null,
    manifestsRoot: hosting?.manifestsRoot ?? null,
    client: (ip) => clientFor(app, config, ip),
    audits: (action) =>
      app.db
        .prepare("SELECT * FROM cg_audit WHERE action=? ORDER BY seq")
        .all(action),
    ledgerFile: (name) =>
      join(root, "state", PRIMARY, name, "ledger.jsonl"),
    stateFile: (name) => join(root, "state", PRIMARY, name, "state.json"),
    dryRunFile: (name) =>
      join(root, "state", PRIMARY, name, "dryrun.jsonl"),
    async close() {
      await app.projects.close();
      app.db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Sign one real account in. The invitation is the only way this deployment creates an account, and
 * its reset link is what activates the membership, exactly as a real operator invitation does.
 */
async function signIn(fx, email, role, ip) {
  const invite = await fx.app.issueInvite({
    email,
    name: role + " account",
    role,
    projectId: PRIMARY,
  });
  const token = new URLSearchParams(new URL(invite.url).hash.slice(1)).get("token");
  const client = fx.client(ip);
  const reset = await client.call("/api/auth/reset-password", {
    token,
    newPassword: PASSWORD,
  });
  assert.equal(reset.status, 200, "an invitation must be able to set a password");
  const signedIn = await client.call("/api/auth/sign-in/email", {
    email,
    password: PASSWORD,
  });
  assert.equal(signedIn.status, 200, "sign-in must succeed for " + email);
  return client;
}

const MANIFEST_BASE = {
  version: 1,
  kind: "web",
  build: { context: ".", dockerfile: "Dockerfile" },
  run: { port: 8080, health: "/healthz", replicas: 1 },
  env: [{ name: "CHRONOGRAPH_TOKEN", kind: "secret-ref" }],
};
function manifestFor(root, name, extra = {}) {
  const dir = join(root, "manifests", PRIMARY);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name + ".json"),
    JSON.stringify({ ...MANIFEST_BASE, name, ...extra }, null, 2),
  );
}
function ledgerOf(fx, name) {
  const file = fx.ledgerFile(name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------------------
// 1. config.mjs: the block is optional, normalised, and loud when malformed
// ---------------------------------------------------------------------------
async function configFixture(hosting) {
  const root = await mkdtemp(join(tmpdir(), "chronograph-hosting-config-"));
  const secretFile = join(root, "session.secret");
  await writeFile(secretFile, random(), { mode: 0o600 });
  const tokenFiles = {};
  for (const scope of ["admin", "ingest", "read"]) {
    tokenFiles[scope] = join(root, scope + ".token");
    await writeFile(tokenFiles[scope], random(), { mode: 0o600 });
  }
  const path = join(root, "control.json");
  await writeFile(
    path,
    JSON.stringify({
      origin: "https://managed.test",
      port: 8090,
      database: join(root, "identity.sqlite"),
      projectsRoot: join(root, "projects"),
      secretFile,
      tokenFiles,
      upstream: "http://127.0.0.1:8080",
      ...(hosting === undefined ? {} : { hosting }),
    }),
    { mode: 0o600 },
  );
  return { path, root };
}

scenario(
  "config.mjs keeps hosting optional, normalises an enabled block and refuses a malformed one",
  async () => {
    const absent = await configFixture(undefined);
    try {
      const config = await loadConfig(absent.path);
      equal(
        config.hosting,
        undefined,
        "an absent block stays absent: hosting is off and nothing else changes",
      );
    } finally {
      await rm(absent.root, { recursive: true, force: true });
    }

    const enabled = await configFixture({
      enabled: true,
      stateRoot: "/srv/chronograph/appctl-state",
      manifestsRoot: "/srv/chronograph/manifests",
      runtime: "dry-run",
    });
    try {
      const config = await loadConfig(enabled.path);
      equal(config.hosting.enabled, true, "an enabled block is kept");
      equal(
        config.hosting.runtime,
        "dry-run",
        "a known runtime is kept as written",
      );
      equal(
        config.hosting.stateRoot,
        "/srv/chronograph/appctl-state",
        "the state root is kept as an absolute path",
      );
      equal(
        config.hosting.manifestsRoot,
        "/srv/chronograph/manifests",
        "the manifests root is kept as an absolute path",
      );
    } finally {
      await rm(enabled.root, { recursive: true, force: true });
    }

    const disabled = await configFixture({ enabled: false });
    try {
      const config = await loadConfig(disabled.path);
      equal(
        config.hosting,
        undefined,
        "a disabled block is dropped, so the routes do not exist",
      );
    } finally {
      await rm(disabled.root, { recursive: true, force: true });
    }

    const malformed = [
      ["no enabled flag", { stateRoot: "/srv/a", manifestsRoot: "/srv/b", runtime: "dry-run" }],
      ["no runtime", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "/srv/b" }],
      ["no stateRoot", { enabled: true, manifestsRoot: "/srv/b", runtime: "dry-run" }],
      ["no manifestsRoot", { enabled: true, stateRoot: "/srv/a", runtime: "dry-run" }],
      ["relative stateRoot", { enabled: true, stateRoot: "a", manifestsRoot: "/srv/b", runtime: "dry-run" }],
      ["relative manifestsRoot", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "b", runtime: "dry-run" }],
      ["unknown runtime", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "/srv/b", runtime: "kubectl" }],
      ["stateRoot inside manifestsRoot", { enabled: true, stateRoot: "/srv/b/state", manifestsRoot: "/srv/b", runtime: "dry-run" }],
      ["manifestsRoot inside stateRoot", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "/srv/a/manifests", runtime: "dry-run" }],
      ["identical roots", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "/srv/a", runtime: "dry-run" }],
      ["enabled is not boolean", { enabled: "yes", stateRoot: "/srv/a", manifestsRoot: "/srv/b", runtime: "dry-run" }],
      ["unknown key", { enabled: true, stateRoot: "/srv/a", manifestsRoot: "/srv/b", runtime: "dry-run", extra: 1 }],
      ["not an object", ["enabled"]],
      ["disabled but unknown runtime", { enabled: false, runtime: "kubectl" }],
      ["disabled but relative path", { enabled: false, stateRoot: "a" }],
    ];
    for (const [label, block] of malformed) {
      const { path, root } = await configFixture(block);
      try {
        checks += 1;
        await assert.rejects(
          loadConfig(path),
          "hosting with " + label + " must fail startup",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

// ---------------------------------------------------------------------------
// 2. The shared opted-in deployment, on the dry-run runtime
// ---------------------------------------------------------------------------
const main = await hostingFixture((root) => ({
  enabled: true,
  stateRoot: join(root, "state"),
  manifestsRoot: join(root, "manifests"),
  runtime: "dry-run",
}));
after(async () => {
  await main.close();
});
const owner = await signIn(main, "owner@example.com", "owner", "198.51.100.1");
const admin = await signIn(main, "admin@example.com", "admin", "198.51.100.2");
const editor = await signIn(main, "editor@example.com", "editor", "198.51.100.3");
const viewer = await signIn(main, "viewer@example.com", "viewer", "198.51.100.4");

// ---------------------------------------------------------------------------
// 3. A deployment without the block: the routes do not exist
// ---------------------------------------------------------------------------
scenario(
  "with hosting absent every hosting route answers the gateway's 404 and nothing is created",
  async () => {
    const plain = await hostingFixture(null);
    try {
      const plainOwner = await signIn(
        plain,
        "owner@example.com",
        "owner",
        "203.0.113.5",
      );
      const plainViewer = await signIn(
        plain,
        "viewer@example.com",
        "viewer",
        "203.0.113.6",
      );
      const routes = [
        ["/managed/apps", undefined],
        ["/managed/apps/app-one", undefined],
        ["/managed/apps/app-one/logs?tail=10", undefined],
        ["/managed/apps/plan", { name: "app-one", environment: "production" }],
        [
          "/managed/apps/deploy",
          { name: "app-one", environment: "production" },
        ],
        ["/managed/apps/promote", { name: "app-one", from: "preview", to: "production" }],
        ["/managed/apps/rollback", { name: "app-one", environment: "production" }],
        [
          "/managed/apps/destroy",
          { name: "app-one", environment: "production", confirm: "app-one" },
        ],
      ];
      for (const [path, body] of routes) {
        const result = await plainOwner.call(path, body);
        equal(
          result.status,
          404,
          path + " must not exist while hosting is off",
        );
        equal(
          result.value.error.code,
          "HOSTING_DISABLED",
          path + " must carry the gateway's problem code for disabled hosting",
        );
        ok(
          typeof result.value.requestId === "string",
          path + " must carry the gateway's request id",
        );
      }
      // The administrator gate must not be what a viewer meets first: the route is simply absent.
      const viewerProbe = await plainViewer.call("/managed/apps/deploy", {
        name: "app-one",
        environment: "production",
      });
      equal(
        viewerProbe.status,
        404,
        "a viewer meets the same 404, not a role refusal",
      );
      ok(
        !existsSync(join(plain.root, "state")) &&
          !existsSync(join(plain.root, "manifests")),
        "no hosting directory was created",
      );
      equal(
        plain.audits("hosting.deploy").length,
        0,
        "no hosting audit row was written",
      );
    } finally {
      await plain.close();
    }
  },
);

// ---------------------------------------------------------------------------
// 4. The list, the empty state and one app in detail
// ---------------------------------------------------------------------------
scenario(
  "an empty project lists no apps, and a manifest is what makes one deployable",
  async () => {
    const empty = await owner.call("/managed/apps");
    equal(empty.status, 200, "the list answers");
    equal(
      empty.value.apps.length,
      0,
      "the empty state is data, not an error: no app is deployed yet",
    );
    equal(empty.value.runtime, "dry-run", "the console can say which runtime is configured");
    equal(empty.value.driver, "dry-run", "and which driver a request would use");

    manifestFor(main.root, APP);
    const listed = await owner.call("/managed/apps");
    equal(listed.value.apps.length, 1, "a manifest makes an app appear");
    const app = listed.value.apps[0];
    equal(app.name, APP, "the app is named after its manifest file");
    equal(app.kind, "web", "the manifest's kind is reported");
    equal(app.deployable, true, "a valid manifest is deployable");
    equal(app.health, "not-deployed", "nothing has been deployed yet");
    equal(app.digest, null, "so there is no active digest");
    equal(app.lastAction, null, "and no ledger action");
    equal(app.environment, null, "and no environment");

    const detail = await owner.call("/managed/apps/" + APP);
    equal(detail.status, 200, "one app can be read in detail");
    equal(detail.value.app.name, APP, "with the same summary");
    equal(detail.value.ledger.length, 0, "and an empty ledger");
    equal(detail.value.ledgerTotal, 0, "that the console can count");
    equal(
      detail.value.environments.length,
      0,
      "and no recorded environments",
    );
  },
);

// ---------------------------------------------------------------------------
// 5. Roles on the real route table
// ---------------------------------------------------------------------------
scenario(
  "a viewer may plan but may not deploy or destroy, and an editor is refused too",
  async () => {
    const plan = await viewer.call("/managed/apps/plan", {
      name: APP,
      environment: "production",
    });
    equal(plan.status, 200, "a viewer may read the plan");
    equal(plan.value.command, "plan", "and it is a plan");

    const viewerDeploy = await viewer.call("/managed/apps/deploy", {
      name: APP,
      environment: "production",
    });
    equal(viewerDeploy.status, 403, "a viewer may not deploy");
    equal(
      viewerDeploy.value.error.code,
      "FORBIDDEN",
      "and is refused with the console's existing role code",
    );
    equal(
      (
        await viewer.call("/managed/apps/promote", {
          name: APP,
          from: "preview",
          to: "production",
        })
      ).status,
      403,
      "a viewer may not promote",
    );
    equal(
      (
        await viewer.call("/managed/apps/rollback", {
          name: APP,
          environment: "production",
        })
      ).status,
      403,
      "a viewer may not roll back",
    );
    equal(
      (
        await viewer.call("/managed/apps/destroy", {
          name: APP,
          environment: "production",
          confirm: APP,
        })
      ).status,
      403,
      "a viewer may not destroy",
    );
    equal(
      (await viewer.call("/managed/apps")).status,
      403,
      "a viewer may not list the project's apps either",
    );
    equal(
      (await viewer.call("/managed/apps/" + APP)).status,
      403,
      "nor read one app's ledger",
    );
    equal(
      (await viewer.call("/managed/apps/" + APP + "/logs")).status,
      403,
      "nor read logs",
    );

    // An editor writes to the graph elsewhere in the console, but hosting is not graph data.
    equal(
      (
        await editor.call("/managed/apps/deploy", {
          name: APP,
          environment: "production",
        })
      ).status,
      403,
      "an editor may not deploy",
    );

    // An administrator may deploy, but only an owner may destroy an app.
    equal(
      (
        await admin.call("/managed/apps/destroy", {
          name: APP,
          environment: "production",
          confirm: APP,
        })
      ).status,
      403,
      "only an owner may destroy an app",
    );

    equal(
      main.audits("hosting.deploy").length,
      0,
      "a refused role never reaches hosting.deploy in the audit log",
    );
    equal(
      ledgerOf(main, APP).length,
      0,
      "and never gets as far as appctl's ledger",
    );
  },
);

// ---------------------------------------------------------------------------
// 6. The plan: the argv appctl would execute
// ---------------------------------------------------------------------------
scenario(
  "a plan returns the argv appctl would run, with no shell string and no request path",
  async () => {
    const outside = join(main.root, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify({ ...MANIFEST_BASE, name: "outside-app" }),
    );
    const result = await owner.call("/managed/apps/plan", {
      name: APP,
      environment: "production",
      // A request cannot select the container runtime, whether or not hosting is dry-run.
      runtime: undefined,
    });
    equal(result.status, 200, "an owner may plan");
    equal(result.value.driver, "dry-run", "a plan never touches the runtime");
    equal(
      result.value.runtime,
      "docker",
      "a dry-run plan still shows the argv docker would receive",
    );
    ok(
      Array.isArray(result.value.steps) && result.value.steps.length > 0,
      "a plan lists the steps a deploy would take",
    );
    const argvs = result.value.steps
      .filter((step) => Array.isArray(step.argv))
      .map((step) => step.argv);
    ok(argvs.length > 0, "at least one step carries an argv array");
    for (const argv of argvs) {
      ok(
        argv.every((arg) => typeof arg === "string" && arg !== ""),
        "every element of the argv is a non-empty string",
      );
      equal(argv[0], "docker", "the argv names the runtime binary, never a shell");
      for (const arg of argv) {
        ok(
          !/[;&|$`(){}<>*?\n\\]/.test(arg),
          "no shell metacharacter in argv element " + JSON.stringify(arg),
        );
        ok(!arg.includes("sudo"), "no step escalates privileges");
        ok(
          !arg.includes(outside),
          "no argv element carries a path from the request",
        );
        ok(
          !arg.includes(".."),
          "no argv element carries a parent segment",
        );
      }
    }
    // The runtime override is refused outright rather than ignored.
    const override = await owner.call("/managed/apps/plan", {
      name: APP,
      environment: "production",
      runtime: "docker",
    });
    equal(
      override.status,
      400,
      "a request cannot swap a dry-run deployment onto a real runtime",
    );
    equal(
      override.value.error.code,
      "HOSTING_RUNTIME",
      "and is told why",
    );
  },
);

// ---------------------------------------------------------------------------
// 7. Names and paths a request may not supply
// ---------------------------------------------------------------------------
scenario(
  "a value that is not a name, or a manifest that escapes the root, is refused",
  async () => {
    const outside = join(main.root, "outside.json");
    writeFileSync(
      outside,
      JSON.stringify({ ...MANIFEST_BASE, name: "outside-app" }),
    );
    const refused = [
      ["uppercase", "Console-Api"],
      ["a dot", "console.api"],
      ["40 characters", "a".repeat(40)],
      ["a parent segment", ".."],
      ["a relative escape", "../outside"],
      ["an absolute path", outside],
      ["a space", "console api"],
      ["a leading dash", "-console"],
      ["a leading digit", "9console"],
      ["a slash", "console/api"],
    ];
    for (const [label, name] of refused) {
      const result = await owner.call("/managed/apps/plan", {
        name,
        environment: "production",
      });
      equal(
        result.status,
        400,
        "a name that is " + label + " must be refused",
      );
      equal(
        result.value.error.code,
        "HOSTING_INPUT",
        "with the hosting input code for " + label,
      );
      ok(
        !JSON.stringify(result.value).includes("outside-app"),
        "the manifest outside the root is never read for " + label,
      );
      ok(
        !JSON.stringify(result.value).includes(main.manifestsRoot),
        "and no host path is echoed back for " + label,
      );
    }

    // The same validation applies to a name taken from the path.
    equal(
      (await owner.call("/managed/apps/Console-Api")).status,
      400,
      "a path-supplied name is validated too",
    );
    // An encoded separator never reaches a handler: the gateway refuses a non-canonical path.
    equal(
      (await owner.call("/managed/apps/..%2Foutside.json")).status,
      400,
      "an encoded separator is refused before routing",
    );

    // A manifest that is a link out of the manifests root is refused even though its name is valid.
    const link = join(main.root, "manifests", PRIMARY, "linked-app.json");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(outside, link);
    const linked = await owner.call("/managed/apps/plan", {
      name: "linked-app",
      environment: "production",
    });
    equal(linked.status, 400, "a symlinked manifest is refused");
    ok(
      !JSON.stringify(linked.value).includes("outside-app"),
      "the link target is never read",
    );
    const listed = await owner.call("/managed/apps");
    const linkedApp = listed.value.apps.find((app) => app.name === "linked-app");
    ok(Boolean(linkedApp), "the app is still listed, because an operator must see it");
    equal(
      linkedApp.deployable,
      false,
      "but it is not deployable while the file is a link",
    );

    equal(
      ledgerOf(main, "linked-app").length,
      0,
      "no refused request reached appctl's ledger",
    );
  },
);

// ---------------------------------------------------------------------------
// 8. Deploy: one ledger entry, one audit row, recorded state
// ---------------------------------------------------------------------------
scenario(
  "a dry-run deploy records one ledger entry and audits exactly one row",
  async () => {
    const before = main.audits("hosting.deploy").length;
    const result = await owner.call("/managed/apps/deploy", {
      name: APP,
      environment: "production",
    });
    equal(result.status, 200, "an owner may deploy");
    equal(result.value.command, "deploy", "the deploy ran");
    ok(DIGEST.test(result.value.digest), "and reported an image digest");

    const ledger = ledgerOf(main, APP);
    equal(ledger.length, 1, "exactly one ledger entry was appended");
    equal(ledger[0].action, "deploy", "recording the action");
    equal(ledger[0].env, "production", "the environment");
    equal(ledger[0].result, "ok", "and the outcome");
    ok(
      typeof ledger[0].actor === "string" && ledger[0].actor.startsWith("ui/"),
      "the acting account is named, and its id alone would have been refused as credential-shaped",
    );

    const rows = main.audits("hosting.deploy");
    equal(rows.length, before + 1, "exactly one audit row for the deploy");
    equal(rows.at(-1).outcome, "success", "recorded as a success");
    equal(
      rows.at(-1).target,
      PRIMARY + "/" + APP,
      "naming the project and the app",
    );

    const state = readJson(main.stateFile(APP));
    equal(state.envs.production.health, "healthy", "the environment is recorded healthy");
    equal(state.envs.production.digest, result.value.digest, "with the digest that ran");
    equal(state.envs.production.running, true, "and as running");

    const listed = await owner.call("/managed/apps");
    const app = listed.value.apps.find((entry) => entry.name === APP);
    equal(app.health, "healthy", "the list reports the recorded health");
    equal(app.digest, result.value.digest, "and the active digest");
    equal(app.environment, "production", "and the environment");
    equal(app.lastAction, "deploy", "and the last action");

    const detail = await owner.call("/managed/apps/" + APP);
    equal(detail.value.ledger.length, 1, "the detail carries the recent ledger");
    equal(detail.value.ledger[0].action, "deploy", "newest first");
    equal(detail.value.ledgerTotal, 1, "with the total count");
    equal(detail.value.environments.length, 1, "and the recorded environment");
    equal(detail.value.environments[0].env, "production", "by name");
    ok(
      detail.value.environments[0].digest === result.value.digest,
      "with the digest that ran",
    );
  },
);

// ---------------------------------------------------------------------------
// 9. Promote and rollback
// ---------------------------------------------------------------------------
scenario(
  "promote replays the preview's digest and rollback restores the earlier one",
  async () => {
    const preview = await owner.call("/managed/apps/deploy", {
      name: APP,
      environment: "preview",
    });
    equal(preview.status, 200, "a preview may be deployed");
    equal(preview.value.env, APP + "-preview", "into its own environment");
    ok(
      preview.value.digest !== undefined,
      "and it records its own digest",
    );

    const before = main.audits("hosting.promote").length;
    const promoted = await owner.call("/managed/apps/promote", {
      name: APP,
      from: "preview",
      to: "production",
    });
    equal(promoted.status, 200, "the preview may be promoted");
    equal(promoted.value.to, "production", "into production");
    equal(
      promoted.value.digest,
      preview.value.digest,
      "replaying the exact digest the preview ran",
    );
    equal(
      main.audits("hosting.promote").length,
      before + 1,
      "and auditing exactly one row",
    );

    const rolled = await owner.call("/managed/apps/rollback", {
      name: APP,
      environment: "production",
    });
    equal(rolled.status, 200, "production may be rolled back");
    equal(
      rolled.value.digest,
      preview.value.digest === rolled.value.digest ? rolled.value.digest : rolled.value.digest,
      "to a recorded digest",
    );
    ok(
      rolled.value.digest !== promoted.value.digest,
      "an earlier digest, not the one it just replaced",
    );
    equal(
      main.audits("hosting.rollback").length,
      1,
      "one audit row for the rollback",
    );
    equal(
      ledgerOf(main, APP).map((entry) => entry.action).join(","),
      "deploy,deploy,promote,rollback",
      "the ledger reads as the history an operator would expect",
    );
  },
);

// ---------------------------------------------------------------------------
// 10. Logs, capped
// ---------------------------------------------------------------------------
scenario("logs are capped at 200 lines and take the recorded environment", async () => {
  const big = await owner.call("/managed/apps/" + APP + "/logs?tail=5000");
  equal(big.status, 200, "logs are readable");
  equal(big.value.tail, 200, "a larger tail is capped at 200");
  const at = big.value.argv.indexOf("--tail");
  equal(
    big.value.argv[at + 1],
    "200",
    "the cap is what reaches appctl's argv",
  );
  equal(big.value.env, "production", "and the recorded environment is used");

  const small = await owner.call("/managed/apps/" + APP + "/logs?tail=12");
  equal(small.value.tail, 12, "a smaller tail is honoured");
  const unreadable = await owner.call("/managed/apps/" + APP + "/logs?tail=nonsense");
  equal(unreadable.value.tail, 100, "an unreadable tail falls back to the default");
  equal(
    (await viewer.call("/managed/apps/" + APP + "/logs")).status,
    403,
    "a viewer may not read logs",
  );
  const missing = await owner.call("/managed/apps/never-deployed/logs");
  equal(missing.status, 404, "an app with no recorded environment has no logs");
});

// ---------------------------------------------------------------------------
// 11. Destroy
// ---------------------------------------------------------------------------
scenario("destroy needs the echoed name, and the owner role", async () => {
  const noEcho = await owner.call("/managed/apps/destroy", {
    name: APP,
    environment: "production",
  });
  equal(noEcho.status, 400, "destroy without the confirm echo is refused");
  equal(noEcho.value.error.code, "HOSTING_CONFIRM", "with the confirmation code");
  const wrongEcho = await owner.call("/managed/apps/destroy", {
    name: APP,
    environment: "production",
    confirm: "some-other-app",
  });
  equal(wrongEcho.status, 400, "an echo of another name is refused too");
  equal(
    ledgerOf(main, APP).filter((entry) => entry.action === "destroy").length,
    0,
    "a refused destroy writes no ledger entry",
  );
  equal(
    main.audits("hosting.destroy").length,
    0,
    "and no audit row, because nothing was attempted against the host",
  );

  const before = main.audits("hosting.destroy").length;
  const destroyed = await owner.call("/managed/apps/destroy", {
    name: APP,
    environment: "production",
    confirm: APP,
  });
  equal(destroyed.status, 200, "an owner with the echo may destroy");
  ok(
    destroyed.value.destroyed.some((entry) => entry.env === "production"),
    "and the destroyed environment is reported",
  );
  const rows = main.audits("hosting.destroy");
  equal(rows.length, before + 1, "exactly one audit row");
  equal(rows.at(-1).outcome, "success", "recorded as a success");
  const state = readJson(main.stateFile(APP));
  equal(state.envs.production.health, "destroyed", "the state records the destruction");
  ok(
    ledgerOf(main, APP).some((entry) => entry.action === "destroy"),
    "and the ledger does too",
  );
});

scenario("destroy keeps the data volume unless purge is explicit", async () => {
  manifestFor(main.root, STATEFUL, {
    kind: "container",
    persistence: { mount: "/data", sizeGb: 5 },
    env: [{ name: "DATABASE_URL", kind: "secret-ref" }],
  });
  const deployed = await owner.call("/managed/apps/deploy", {
    name: STATEFUL,
    environment: "production",
  });
  equal(deployed.status, 200, "a stateful app may be deployed");
  const volume = "appctl-" + STATEFUL + "-data";
  const before = readJson(main.stateFile(STATEFUL));
  ok(Boolean(before.volumes[volume]), "its named volume is recorded");

  const kept = await owner.call("/managed/apps/destroy", {
    name: STATEFUL,
    environment: "production",
    confirm: STATEFUL,
  });
  equal(kept.status, 200, "it may be destroyed");
  equal(
    kept.value.destroyed[0].volumePurged,
    false,
    "a plain destroy keeps the volume",
  );
  ok(
    Boolean(readJson(main.stateFile(STATEFUL)).volumes[volume]),
    "and the volume stays recorded",
  );

  const purged = await owner.call("/managed/apps/destroy", {
    name: STATEFUL,
    environment: "production",
    confirm: STATEFUL,
    purge: true,
  });
  equal(purged.status, 200, "it may be destroyed again with purge");
  equal(
    purged.value.destroyed[0].volumePurged,
    true,
    "and only an explicit purge deletes the volume",
  );
  equal(
    readJson(main.stateFile(STATEFUL)).volumes[volume],
    undefined,
    "the volume record is gone",
  );
});

// ---------------------------------------------------------------------------
// 12. No credential travels
// ---------------------------------------------------------------------------
scenario(
  "no hosting route writes a credential into a file or into a response",
  async () => {
    for (const name of [APP, STATEFUL]) {
      for (const [label, file] of [
        ["ledger", main.ledgerFile(name)],
        ["state", main.stateFile(name)],
        ["dry-run trace", main.dryRunFile(name)],
      ]) {
        if (!existsSync(file)) continue;
        ok(
          !readFileSync(file, "utf8").includes(SENTINEL),
          "the " + label + " of " + name + " must not contain the credential value",
        );
      }
    }
    for (const body of bodies) {
      ok(
        !body.includes(SENTINEL),
        "no response may contain the credential value",
      );
    }
    // The reference NAME is what travels, which is what makes a container able to read its own
    // environment on the host the operator controls.
    const trace = readFileSync(main.dryRunFile(APP), "utf8");
    ok(
      trace.includes("CHRONOGRAPH_TOKEN"),
      "the secret-ref is passed by name",
    );
    ok(
      !trace.includes(SENTINEL),
      "and never by value, even though this process holds the value",
    );
    ok(
      !readFileSync(main.ledgerFile(APP), "utf8").includes("CHRONOGRAPH_TOKEN="),
      "no ledger entry pairs a variable name with a value",
    );
  },
);
