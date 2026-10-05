#!/usr/bin/env node
/**
 * Evidence for Layer 4 app hosting: every appctl command is exercised end to end against the
 * dry-run driver, so the lifecycle is proven without a daemon, an image or a network.
 *
 * WHY the dry-run trace is asserted rather than the exit code alone: an exit code says a command
 * finished, the recorded argv says what it would have done to the host - which image digest, which
 * named volume, which published port. Run with: node scripts/appctl-test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPCTL = join(ROOT, "deploy/platform/appctl.mjs");
const EXAMPLE = join(ROOT, "deploy/platform/app.example.json");
const APP = "example-neural-app";
const REPO = "appctl/" + APP;
const PREVIEW = APP + "-preview";
// A distinctive dummy so "the secret value reached a file" is a searchable fact, not a guess.
const DUMMY_TOKEN = "dummy-token-value-for-tests-only";
const DUMMY_ZONE = "test-zone-id";
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const workspace = mkdtempSync(join(tmpdir(), "appctl-test-"));
const stateA = join(workspace, "state-agent");
const stateB = join(workspace, "state-refusals");
const stateC = join(workspace, "state-empty");
const stateD = join(workspace, "state-nodigest");
const manifestPath = join(workspace, "chronograph.app.json");

const baseManifest = {
  version: 1,
  name: APP,
  kind: "container",
  build: { context: ".", dockerfile: "Dockerfile" },
  run: { port: 8080, health: "/healthz", replicas: 1 },
  persistence: {
    mount: "/data",
    sizeGb: 20,
    note: "A database needs durable local storage.",
  },
  domains: [
    {
      hostname: "app.example.com",
      provider: "cloudflare-saas",
      env: ["CHRONOGRAPH_DOMAINS_API_TOKEN", "CHRONOGRAPH_DOMAINS_ZONE"],
    },
  ],
  env: [
    { name: "CHRONOGRAPH_URL", kind: "plain" },
    { name: "CHRONOGRAPH_DATABASE_DSN", kind: "secret-ref" },
  ],
  stores: [
    {
      store: "play",
      artifact: "app-release.aab",
      requires: "operator account, app record and upload key",
    },
    {
      store: "app-store",
      artifact: "app.ipa",
      requires: "operator account, bundle ID and distribution certificate",
    },
  ],
  boundary: "Building and running the app is automated locally.",
};

function writeManifest(file, patch = {}) {
  const manifest = { ...baseManifest, ...patch };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}

writeManifest(manifestPath);

/**
 * Run appctl and return its exit code plus the parsed JSON document.
 * @param {string[]} args
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ code: number, json: object|null, stdout: string, stderr: string }}
 */
function appctl(args, extraEnv = {}) {
  const wantsJson = args.includes("--json");
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [APPCTL, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A non-zero exit is a normal outcome under test, so the spawn failure becomes data rather
    // than an exception; anything that is not an exit status is a real harness error.
    if (typeof error.status !== "number") throw error;
    stdout = error.stdout ? error.stdout.toString() : "";
    stderr = error.stderr ? error.stderr.toString() : "";
    code = error.status;
  }
  const json = wantsJson && stdout.trim() !== "" ? JSON.parse(stdout) : null;
  return { code, json, stdout, stderr };
}

function dryRunArgs(command, stateDir, extra = []) {
  return [
    command,
    "--manifest",
    manifestPath,
    "--driver",
    "dry-run",
    "--state-dir",
    stateDir,
    "--json",
    ...extra,
  ];
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function stateDirOf(stateRoot) {
  return join(stateRoot, APP);
}

function assertOk(result, label) {
  assert.equal(
    result.code,
    0,
    label + " exited " + result.code + "\n" + result.stdout + result.stderr,
  );
  assert.ok(result.json, label + " printed no JSON document");
  assert.equal(result.json.ok, true, label + " reported ok=false");
}

function assertRefused(result, code, label) {
  assert.notEqual(
    result.code,
    0,
    label + " should have failed but exited 0: " + result.stdout,
  );
  assert.ok(result.json, label + " printed no JSON document");
  assert.equal(result.json.ok, false, label + " should report ok=false");
  assert.equal(
    result.json.error.code,
    code,
    label + " refused with " + JSON.stringify(result.json.error),
  );
}

const passed = [];
const failed = [];
async function check(name, body) {
  await test(name, async () => {
    try {
      await body();
      passed.push(name);
    } catch (error) {
      failed.push({ name, message: error.message });
      throw error;
    }
  });
}

process.on("exit", () => {
  const summary =
    failed.length === 0
      ? { passed: true, checks: passed.length }
      : { passed: false, checks: passed.length, failures: failed };
  process.stdout.write(JSON.stringify(summary) + "\n");
});

await check("plan prints the volume, build, run and health steps", () => {
  const result = appctl(dryRunArgs("plan", stateA));
  assertOk(result, "plan");
  const actions = result.json.steps.map((step) => step.action);
  assert.deepEqual(
    actions.slice(0, 4),
    ["volume-create", "build", "run", "health"],
    JSON.stringify(actions),
  );
  assert.equal(result.json.env, "production");
  assert.equal(result.json.container, "appctl-" + APP);
  assert.equal(result.json.volume, "appctl-" + APP + "-data");
  assert.equal(result.json.volumeSizeGb, 20);
  assert.equal(result.json.hostPort, 8080);
  const run = result.json.steps.find((step) => step.action === "run");
  assert.ok(
    run.argv.includes("type=volume,src=appctl-" + APP + "-data,dst=/data"),
    "run step mounts the declared named volume: " + run.argv.join(" "),
  );
  assert.ok(
    result.json.steps.some((step) => step.action === "bind-domain"),
    "plan lists the declared domain",
  );
});

await check(
  "plan --preview targets <app>-preview on a different host port",
  () => {
    const result = appctl(dryRunArgs("plan", stateA, ["--preview"]));
    assertOk(result, "plan --preview");
    assert.equal(result.json.env, PREVIEW);
    assert.equal(result.json.container, "appctl-" + PREVIEW);
    assert.equal(result.json.volume, "appctl-" + PREVIEW + "-data");
    assert.equal(result.json.hostPort, 8081);
  },
);

await check("the shipped app.example.json validates", () => {
  const result = appctl([
    "plan",
    "--manifest",
    EXAMPLE,
    "--driver",
    "dry-run",
    "--state-dir",
    join(workspace, "state-example"),
    "--json",
  ]);
  assertOk(result, "plan on app.example.json");
  assert.equal(result.json.app, APP);
  assert.equal(
    result.json.steps.filter((step) => step.action === "publish-store").length,
    2,
  );
});

await check("build records an image digest", () => {
  const result = appctl(dryRunArgs("build", stateA));
  assertOk(result, "build");
  assert.match(result.json.digest, DIGEST);
  assert.deepEqual(result.json.calls[0].slice(0, 4), [
    "docker",
    "build",
    "-t",
    REPO + ":production",
  ]);
});

await check("deploy --no-build runs the recorded digest in production", () => {
  const result = appctl(dryRunArgs("deploy", stateA, ["--no-build"]));
  assertOk(result, "deploy");
  assert.match(result.json.digest, DIGEST);
  assert.equal(result.json.hostPort, 8080);
  assert.equal(result.json.health.status, 200);
  const run = result.json.calls.find((call) => call.kind === "run");
  assert.ok(
    run.argv.includes(REPO + "@" + result.json.digest),
    "run replays the recorded digest: " + run.argv.join(" "),
  );
  assert.ok(
    run.argv.includes("127.0.0.1:8080:8080"),
    "the port is published on loopback only",
  );
  // A secret-ref is passed by NAME: the value stays in the operator's environment.
  assert.ok(
    run.argv.includes("CHRONOGRAPH_DATABASE_DSN"),
    "secret-ref is passed by name",
  );
  assert.ok(
    !run.argv.some((arg) => arg.startsWith("CHRONOGRAPH_DATABASE_DSN=")),
    "secret-ref never carries a value",
  );
  writeFileSync(join(workspace, "production-digest.txt"), result.json.digest);
});

await check(
  "deploy --preview builds a second image and a separate environment",
  () => {
    const result = appctl(dryRunArgs("deploy", stateA, ["--preview"]));
    assertOk(result, "deploy --preview");
    assert.equal(result.json.env, PREVIEW);
    assert.equal(result.json.container, "appctl-" + PREVIEW);
    assert.equal(result.json.hostPort, 8081);
    const production = readFileSync(
      join(workspace, "production-digest.txt"),
      "utf8",
    );
    assert.notEqual(
      result.json.digest,
      production,
      "a preview build is its own image",
    );
    writeFileSync(join(workspace, "preview-digest.txt"), result.json.digest);
  },
);

await check(
  "promote runs the exact preview digest in production and records it",
  () => {
    const digest = readFileSync(join(workspace, "preview-digest.txt"), "utf8");
    // The documented spelling is "promote --from preview": the alias must resolve to <app>-preview.
    const result = appctl(
      dryRunArgs("promote", stateA, [
        "--from",
        "preview",
        "--to",
        "production",
      ]),
    );
    assertOk(result, "promote");
    assert.equal(result.json.from, PREVIEW);
    assert.equal(result.json.digest, digest);
    const tag = result.json.calls.find((call) => call.kind === "tag");
    assert.ok(tag, "promote re-tags the digest");
    assert.ok(
      tag.argv.includes(REPO + "@" + digest) &&
        tag.argv.includes(REPO + ":production"),
      tag.argv.join(" "),
    );
    const run = result.json.calls.find((call) => call.kind === "run");
    assert.ok(
      run.argv.includes(REPO + "@" + digest),
      "production runs the promoted digest: " + run.argv.join(" "),
    );
    assert.ok(
      run.argv.includes("chronograph.promoted-from=" + PREVIEW),
      "the container is relabelled with its source",
    );
    const ledger = readJsonl(join(stateDirOf(stateA), "ledger.jsonl"));
    const entry = ledger.filter((record) => record.action === "promote").pop();
    assert.equal(entry.digest, digest);
    assert.equal(entry.app, APP);
    assert.equal(entry.env, "production");
    assert.equal(entry.result, "ok");
    assert.ok(
      typeof entry.at === "string" && entry.at.length > 0,
      "the ledger records when",
    );
    assert.ok(
      typeof entry.actor === "string" && entry.actor.length > 0,
      "the ledger records who",
    );
    const trace = readJsonl(join(stateDirOf(stateA), "dryrun.jsonl"));
    assert.ok(
      trace.some(
        (call) =>
          call.kind === "run" && call.argv.includes(REPO + "@" + digest),
      ),
      "the persisted dry-run trace shows the promoted digest",
    );
  },
);

await check("rollback runs the previously recorded digest again", () => {
  const before = appctl(dryRunArgs("status", stateA));
  assertOk(before, "status");
  const result = appctl(
    dryRunArgs("rollback", stateA, ["--env", "production"]),
  );
  assertOk(result, "rollback");
  const production = readFileSync(
    join(workspace, "production-digest.txt"),
    "utf8",
  );
  assert.equal(
    result.json.digest,
    production,
    "rollback returns to the earlier digest",
  );
  const run = result.json.calls.find((call) => call.kind === "run");
  assert.ok(run.argv.includes(REPO + "@" + production));
  const ledger = readJsonl(join(stateDirOf(stateA), "ledger.jsonl"));
  assert.equal(
    ledger.filter((record) => record.action === "rollback").pop().digest,
    production,
  );
});

await check("status reports both environments running and healthy", () => {
  const result = appctl(dryRunArgs("status", stateA));
  assertOk(result, "status");
  const byEnv = Object.fromEntries(
    result.json.envs.map((entry) => [entry.env, entry]),
  );
  assert.equal(byEnv.production.running, true);
  assert.equal(byEnv.production.healthy, true);
  assert.equal(byEnv[PREVIEW].running, true);
  assert.equal(byEnv[PREVIEW].port, 8081);
  assert.match(byEnv.production.digest, DIGEST);
});

await check("logs --tail returns at most N lines from the container", () => {
  const result = appctl(dryRunArgs("logs", stateA, ["--tail", "5"]));
  assertOk(result, "logs");
  assert.ok(result.json.lines.length <= 5, "tail is respected");
  assert.ok(result.json.lines.length > 0);
  assert.deepEqual(result.json.argv, [
    "docker",
    "logs",
    "--tail",
    "5",
    "appctl-" + APP,
  ]);
});

await check("bind-domain fails closed without the secret reference", () => {
  const result = appctl(
    dryRunArgs("bind-domain", stateA, ["--hostname", "app.example.com"]),
    {
      CHRONOGRAPH_DOMAINS_API_TOKEN: "",
      CHRONOGRAPH_DOMAINS_ZONE: DUMMY_ZONE,
    },
  );
  assertRefused(
    result,
    "missing-secret-reference",
    "bind-domain without the token",
  );
  assert.equal(result.json.error.reference, "CHRONOGRAPH_DOMAINS_API_TOKEN");
  assert.ok(
    result.json.error.message.includes("missing secret reference"),
    result.json.error.message,
  );
  assert.ok(
    !existsSync(join(stateDirOf(stateA), "domains.jsonl")),
    "a refused bind writes no provider request",
  );
  const ledger = readJsonl(join(stateDirOf(stateA), "ledger.jsonl"));
  assert.equal(
    ledger.filter((record) => record.action === "bind-domain").pop().result,
    "refused",
  );
});

await check(
  "bind-domain succeeds with the reference set and records the redacted request",
  () => {
    const result = appctl(
      dryRunArgs("bind-domain", stateA, ["--hostname", "app.example.com"]),
      {
        CHRONOGRAPH_DOMAINS_API_TOKEN: DUMMY_TOKEN,
        CHRONOGRAPH_DOMAINS_ZONE: DUMMY_ZONE,
      },
    );
    assertOk(result, "bind-domain");
    assert.equal(result.json.result.recorded, true);
    assert.equal(result.json.result.provider, "cloudflare-saas");
    assert.equal(
      result.json.result.request.headers.authorization,
      "<redacted CHRONOGRAPH_DOMAINS_API_TOKEN>",
    );
    assert.ok(
      result.json.result.request.url.includes(
        "/zones/" + DUMMY_ZONE + "/custom_hostnames",
      ),
      result.json.result.request.url,
    );
    assert.ok(
      !JSON.stringify(result.json).includes(DUMMY_TOKEN),
      "the token value never reaches the output",
    );
    const requests = readJsonl(join(stateDirOf(stateA), "domains.jsonl"));
    assert.equal(requests.length, 1);
    assert.ok(
      !readFileSync(join(stateDirOf(stateA), "domains.jsonl"), "utf8").includes(
        DUMMY_TOKEN,
      ),
      "the token value never reaches the request log",
    );
    const ledger = readJsonl(join(stateDirOf(stateA), "ledger.jsonl"));
    const entry = ledger
      .filter((record) => record.action === "bind-domain")
      .pop();
    assert.equal(entry.result, "ok");
    assert.equal(entry.secretRef, "CHRONOGRAPH_DOMAINS_API_TOKEN");
  },
);

await check("no credential value reaches any file under the state root", () => {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (readFileSync(path, "utf8").includes(DUMMY_TOKEN))
        found.push(path);
    }
  };
  walk(workspace);
  assert.deepEqual(
    found,
    [],
    "the dummy credential value must not be written anywhere",
  );
});

await check(
  "bind-domain refuses a hostname the manifest does not declare",
  () => {
    const result = appctl(
      dryRunArgs("bind-domain", stateA, ["--hostname", "other.example.com"]),
      {
        CHRONOGRAPH_DOMAINS_API_TOKEN: DUMMY_TOKEN,
        CHRONOGRAPH_DOMAINS_ZONE: DUMMY_ZONE,
      },
    );
    assertRefused(
      result,
      "undeclared-hostname",
      "bind-domain for an undeclared hostname",
    );
  },
);

await check(
  "destroy keeps the data volume unless --purge-volume is passed",
  () => {
    const result = appctl(dryRunArgs("destroy", stateA, ["--env", PREVIEW]));
    assertOk(result, "destroy preview");
    assert.equal(result.json.destroyed[0].env, PREVIEW);
    assert.equal(result.json.destroyed[0].volumePurged, false);
    assert.ok(
      !result.json.destroyed[0].calls.some((call) =>
        call.argv.includes("volume"),
      ),
      "no volume removal without --purge-volume",
    );
    const state = JSON.parse(
      readFileSync(join(stateDirOf(stateA), "state.json"), "utf8"),
    );
    assert.equal(state.envs[PREVIEW].volumeRetained, true);
    assert.ok(
      state.volumes["appctl-" + PREVIEW + "-data"],
      "the volume stays recorded",
    );
  },
);

await check(
  "destroy --purge-volume removes the container and the named volume",
  () => {
    const result = appctl(dryRunArgs("destroy", stateA, ["--purge-volume"]));
    assertOk(result, "destroy --purge-volume");
    assert.equal(result.json.destroyed[0].env, "production");
    assert.equal(result.json.destroyed[0].volumePurged, true);
    assert.ok(
      result.json.destroyed[0].calls.some(
        (call) =>
          call.kind === "volume-remove" &&
          call.argv[1] === "volume" &&
          call.argv[2] === "rm",
      ),
      "the volume removal command is recorded: " +
        JSON.stringify(result.json.destroyed[0].calls),
    );
    const state = JSON.parse(
      readFileSync(join(stateDirOf(stateA), "state.json"), "utf8"),
    );
    assert.equal(state.volumes["appctl-" + APP + "-data"], undefined);
    const ledger = readJsonl(join(stateDirOf(stateA), "ledger.jsonl"));
    assert.equal(
      ledger.filter((record) => record.action === "destroy").length,
      2,
    );
    const status = appctl(dryRunArgs("status", stateA));
    assertOk(status, "status after destroy");
    const production = status.json.envs.find(
      (entry) => entry.env === "production",
    );
    assert.equal(production.running, false);
    assert.equal(production.exists, true);
  },
);

await check("deploy refuses a request above the declared volume size", () => {
  const result = appctl(
    dryRunArgs("deploy", stateA, ["--no-build", "--size-gb", "40"]),
  );
  assertRefused(result, "requested-over-declared", "deploy --size-gb 40");
  assert.ok(
    result.json.error.message.includes("exceeds"),
    result.json.error.message,
  );
});

await check(
  "deploy refuses a volume whose recorded size disagrees with the manifest",
  () => {
    const stateE = join(workspace, "state-grown");
    const first = appctl(dryRunArgs("deploy", stateE));
    assertOk(first, "deploy with the declared 20GB volume");
    const grown = writeManifest(
      join(workspace, "grown", "chronograph.app.json"),
      {
        persistence: { mount: "/data", sizeGb: 30 },
      },
    );
    const result = appctl([
      "deploy",
      "--manifest",
      grown,
      "--driver",
      "dry-run",
      "--state-dir",
      stateE,
      "--json",
      "--no-build",
    ]);
    assertRefused(
      result,
      "volume-size-mismatch",
      "deploy after growing persistence.sizeGb",
    );
  },
);

await check("promote refuses an unhealthy preview", () => {
  const unhealthy = appctl(
    dryRunArgs("deploy", stateB, [
      "--preview",
      "--simulate",
      "unhealthy",
      "--health-timeout",
      "300",
      "--health-interval",
      "50",
    ]),
  );
  assertRefused(
    unhealthy,
    "unhealthy",
    "deploy --preview --simulate unhealthy",
  );
  assert.equal(unhealthy.json.error.detail.lastResponse.status, 503);
  assert.ok(
    unhealthy.json.error.detail.lastResponse.body.includes("unhealthy"),
    unhealthy.json.error.detail.lastResponse.body,
  );
  assert.ok(
    unhealthy.json.error.detail.attempts >= 2,
    "the health loop retried before giving up",
  );
  const kinds = unhealthy.json.dryRunCalls.map((call) => call.kind);
  assert.ok(
    kinds.includes("stop") && kinds.includes("rm"),
    "a failed deploy stops and removes the container: " + kinds.join(","),
  );
  const result = appctl(
    dryRunArgs("promote", stateB, ["--from", PREVIEW, "--to", "production"]),
  );
  assertRefused(
    result,
    "preview-unhealthy",
    "promote with an unhealthy preview",
  );
});

await check(
  "promote refuses a preview that has stopped answering health",
  () => {
    const healthy = appctl(
      dryRunArgs("deploy", stateB, [
        "--preview",
        "--health-timeout",
        "300",
        "--health-interval",
        "50",
      ]),
    );
    assertOk(healthy, "deploy --preview healthy");
    const result = appctl(
      dryRunArgs("promote", stateB, [
        "--from",
        PREVIEW,
        "--to",
        "production",
        "--simulate",
        "unhealthy",
      ]),
    );
    assertRefused(
      result,
      "preview-unhealthy",
      "promote with a preview that is currently unhealthy",
    );
    assert.ok(
      result.json.error.message.includes("not healthy"),
      result.json.error.message,
    );
  },
);

await check(
  "promote refuses when the source environment was never deployed",
  () => {
    const result = appctl(
      dryRunArgs("promote", stateC, ["--from", PREVIEW, "--to", "production"]),
    );
    assertRefused(
      result,
      "unknown-environment",
      "promote with no recorded preview",
    );
  },
);

await check(
  "promote refuses when no digest is recorded for the preview",
  () => {
    const dir = join(stateD, APP);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(
        {
          version: 1,
          app: APP,
          builds: [],
          envs: {
            [PREVIEW]: {
              env: PREVIEW,
              container: "appctl-" + PREVIEW,
              health: "healthy",
              running: true,
              port: 8081,
              digest: null,
            },
          },
          volumes: {},
          domains: {},
          updatedAt: null,
        },
        null,
        2,
      ),
    );
    const result = appctl(
      dryRunArgs("promote", stateD, ["--from", PREVIEW, "--to", "production"]),
    );
    assertRefused(
      result,
      "missing-digest",
      "promote without a recorded digest",
    );
  },
);

await check("host port collisions are avoided across environments", () => {
  const result = appctl(dryRunArgs("deploy", stateC));
  assertOk(result, "deploy production in a fresh state root");
  const preview = appctl(dryRunArgs("deploy", stateC, ["--preview"]));
  assertOk(preview, "deploy preview in the same state root");
  assert.notEqual(
    preview.json.hostPort,
    result.json.hostPort,
    "preview and production never share a host port",
  );
  assert.equal(result.json.hostPort, 8080);
  assert.equal(preview.json.hostPort, 8081);
});

await check("deploy refuses a replica count this runtime cannot honour", () => {
  const file = writeManifest(
    join(workspace, "replicas", "chronograph.app.json"),
    {
      run: { port: 8080, health: "/healthz", replicas: 3 },
    },
  );
  const result = appctl([
    "deploy",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    join(workspace, "state-replicas"),
    "--json",
  ]);
  assertRefused(result, "unsupported-replicas", "deploy with run.replicas 3");
});

await check("manifest validation rejects port 0", () => {
  const file = writeManifest(
    join(workspace, "bad-port", "chronograph.app.json"),
    { run: { port: 0, health: "/healthz", replicas: 1 } },
  );
  const result = appctl([
    "plan",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    stateA,
    "--json",
  ]);
  assertRefused(result, "invalid-port", "manifest with port 0");
});

await check("manifest validation rejects a missing health path", () => {
  const file = writeManifest(
    join(workspace, "bad-health", "chronograph.app.json"),
    { run: { port: 8080, replicas: 1 } },
  );
  const result = appctl([
    "plan",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    stateA,
    "--json",
  ]);
  assertRefused(
    result,
    "invalid-health-path",
    "manifest without a health path",
  );
});

await check("manifest validation rejects a relative persistence mount", () => {
  const file = writeManifest(
    join(workspace, "bad-mount", "chronograph.app.json"),
    { persistence: { mount: "data", sizeGb: 20 } },
  );
  const result = appctl([
    "plan",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    stateA,
    "--json",
  ]);
  assertRefused(result, "relative-mount", "manifest with a relative mount");
});

await check(
  "manifest validation rejects a stateful container with no persistence",
  () => {
    const file = writeManifest(
      join(workspace, "no-storage", "chronograph.app.json"),
    );
    const raw = JSON.parse(readFileSync(file, "utf8"));
    delete raw.persistence;
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    const result = appctl([
      "plan",
      "--manifest",
      file,
      "--driver",
      "dry-run",
      "--state-dir",
      stateA,
      "--json",
    ]);
    assertRefused(
      result,
      "persistence-required",
      "stateful container without persistence",
    );
    assert.ok(
      result.json.error.message.includes("CHRONOGRAPH_DATABASE_DSN"),
      result.json.error.message,
    );
  },
);

await check("manifest validation rejects an unknown kind", () => {
  const file = writeManifest(
    join(workspace, "bad-kind", "chronograph.app.json"),
    { kind: "lambda" },
  );
  const result = appctl([
    "plan",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    stateA,
    "--json",
  ]);
  assertRefused(result, "unknown-kind", "manifest with an unknown kind");
});

await check(
  "manifest validation rejects a secret-ref that carries a value",
  () => {
    const file = writeManifest(
      join(workspace, "bad-secret", "chronograph.app.json"),
    );
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.env[1] = {
      name: "CHRONOGRAPH_DATABASE_DSN",
      kind: "secret-ref",
      value: "postgres://user:pw@localhost/db",
    };
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    const result = appctl([
      "plan",
      "--manifest",
      file,
      "--driver",
      "dry-run",
      "--state-dir",
      stateA,
      "--json",
    ]);
    assertRefused(result, "credential-in-manifest", "secret-ref with a value");
    assert.ok(
      !result.json.error.message.includes("postgres://"),
      "the refused value is never echoed: " + result.json.error.message,
    );
  },
);

await check(
  "manifest validation rejects a plain variable that names a credential",
  () => {
    const file = writeManifest(
      join(workspace, "bad-plain", "chronograph.app.json"),
    );
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.env[0] = { name: "CHRONOGRAPH_API_TOKEN", kind: "plain" };
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    const result = appctl([
      "plan",
      "--manifest",
      file,
      "--driver",
      "dry-run",
      "--state-dir",
      stateA,
      "--json",
    ]);
    assertRefused(
      result,
      "credential-looking-name",
      "plain credential-looking variable",
    );
  },
);

await check("manifest validation rejects an unknown domain provider", () => {
  const file = writeManifest(
    join(workspace, "bad-provider", "chronograph.app.json"),
  );
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.domains[0].provider = "route53";
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  const result = appctl([
    "plan",
    "--manifest",
    file,
    "--driver",
    "dry-run",
    "--state-dir",
    stateA,
    "--json",
  ]);
  assertRefused(result, "domain-provider", "manifest with an unknown provider");
});

await check(
  "manifest validation refuses credential-shaped text anywhere in the file",
  () => {
    const file = writeManifest(
      join(workspace, "leaky", "chronograph.app.json"),
    );
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.boundary = "uses " + ["sk", "live", "0123456789abcdef0123456789abcdef"].join("_") + " for billing";
    writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
    const result = appctl([
      "plan",
      "--manifest",
      file,
      "--driver",
      "dry-run",
      "--state-dir",
      stateA,
      "--json",
    ]);
    assertRefused(
      result,
      "credential-in-manifest",
      "manifest carrying a credential literal",
    );
    assert.ok(
      !result.json.error.message.includes("sk_" + "live_0123456789"),
      "the refused literal is never echoed",
    );
  },
);

await check("every command in the interface is implemented", () => {
  const help = appctl(["--help"]);
  assert.equal(help.code, 0);
  for (const command of [
    "plan",
    "build",
    "deploy",
    "promote",
    "rollback",
    "status",
    "logs",
    "destroy",
    "bind-domain",
  ]) {
    assert.ok(help.stdout.includes(command), "usage text names " + command);
  }
  const unknown = appctl(["publish", "--json"]);
  assertRefused(unknown, "unknown-command", "an unimplemented command");
});
