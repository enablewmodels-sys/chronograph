/**
 * On-disk state, the append-only ledger and the dry-run trace for Layer 4 app hosting.
 *
 * WHY every write funnels through this module: the ledger is the audit record an operator reads
 * after an incident, so it must be append-only and it must never be able to hold a credential
 * value - the guards here reject a record before it reaches the file.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { findSecretLiteral, looksLikeOpaqueToken } from "./manifest.mjs";

/** State layout version, bumped when the shape of state.json changes incompatibly. */
export const STATE_VERSION = 1;
const LEDGER_FILE = "ledger.jsonl";
const DRYRUN_FILE = "dryrun.jsonl";
const DOMAINS_FILE = "domains.jsonl";
const STATE_FILE = "state.json";
// Keys whose name alone means "a credential value lives here". The ledger records reference
// NAMES (tokenRef, secretRef) and never values, so a bare `value` key is always a bug.
const FORBIDDEN_KEYS =
  /^(value|values|secret|password|passwd|token|apikey|api_key|credential)$/i;

/** A record that must not be written to disk. */
export class StateError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description
   */
  constructor(code, message) {
    super(message);
    this.name = "StateError";
    this.code = code;
    this.exitCode = 1;
  }
}

/**
 * Walk a record and refuse it when it could carry a credential into a file.
 * @param {unknown} node any JSON-shaped value
 * @param {string} path dotted path used in the error message
 * @returns {void}
 */
export function assertRecordIsSecretFree(node, path = "$") {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) =>
      assertRecordIsSecretFree(item, path + "[" + index + "]"),
    );
    return;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new StateError(
          "secret-key-in-record",
          "refusing to write " +
            path +
            "." +
            key +
            ": records hold secret reference NAMES, never values",
        );
      }
      assertRecordIsSecretFree(value, path + "." + key);
    }
    return;
  }
  if (typeof node === "string") {
    const label = findSecretLiteral(node);
    if (label) {
      throw new StateError(
        "secret-value-in-record",
        "refusing to write " + path + ": it carries what looks like a " + label,
      );
    }
    // Digests and image refs pass through here, which is why the opaque check exempts hex and
    // any string carrying punctuation; only a bare mixed-case blob is treated as a credential.
    if (looksLikeOpaqueToken(node)) {
      throw new StateError(
        "secret-value-in-record",
        "refusing to write " +
          path +
          ": it carries an opaque token-shaped value",
      );
    }
  }
}

/**
 * Resolve the state root: flag, then environment, then ./.appctl.
 * @param {{ flag?: string, env?: Record<string, string|undefined>, cwd?: string }} [options]
 * @returns {string} absolute state root
 */
export function resolveStateRoot(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  if (options.flag) return resolve(options.flag);
  if (env.CHRONOGRAPH_APPCTL_STATE_DIR)
    return resolve(env.CHRONOGRAPH_APPCTL_STATE_DIR);
  return join(resolve(cwd), ".appctl");
}

/**
 * Directory holding one app's state, ledger and traces.
 * @param {string} root state root
 * @param {string} app app name
 * @returns {string} absolute directory
 */
export function appStateDir(root, app) {
  return join(resolve(root), app);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Read one app's state, returning an empty skeleton when it has never been deployed.
 * @param {string} root state root
 * @param {string} app app name
 * @returns {object} state document
 */
export function readAppState(root, app) {
  const file = join(appStateDir(root, app), STATE_FILE);
  if (!existsSync(file)) {
    return {
      version: STATE_VERSION,
      app,
      builds: [],
      envs: {},
      volumes: {},
      domains: {},
      updatedAt: null,
    };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    version: parsed.version ?? STATE_VERSION,
    app,
    builds: parsed.builds ?? [],
    envs: parsed.envs ?? {},
    volumes: parsed.volumes ?? {},
    domains: parsed.domains ?? {},
    updatedAt: parsed.updatedAt ?? null,
  };
}

/**
 * Write one app's state atomically enough for a CLI: a temp file then a rename.
 * @param {string} root state root
 * @param {string} app app name
 * @param {object} state state document
 * @returns {string} path written
 */
export function writeAppState(root, app, state) {
  assertRecordIsSecretFree({
    envs: state.envs,
    volumes: state.volumes,
    builds: state.builds,
    domains: state.domains ?? {},
  });
  const dir = appStateDir(root, app);
  ensureDir(dir);
  const document = {
    ...state,
    version: STATE_VERSION,
    app,
    domains: state.domains ?? {},
    updatedAt: new Date().toISOString(),
  };
  const file = join(dir, STATE_FILE);
  // Write beside the target and rename: a truncated state file after a crash would lose the
  // recorded digests that promotion and rollback depend on.
  const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(document, null, 2) + "\n");
  renameSync(temp, file);
  return file;
}

/**
 * Append one record to the app's ledger, refusing credential-bearing or key-less records.
 * @param {string} root state root
 * @param {string} app app name
 * @param {object} record ledger record
 * @returns {object} the record as written
 */
export function appendLedger(root, app, record) {
  assertRecordIsSecretFree(record, "ledger");
  const dir = appStateDir(root, app);
  ensureDir(dir);
  appendFileSync(join(dir, LEDGER_FILE), JSON.stringify(record) + "\n");
  return record;
}

/**
 * Read the append-only ledger.
 * @param {string} root state root
 * @param {string} app app name
 * @returns {object[]} ledger records in write order
 */
export function readLedger(root, app) {
  const file = join(appStateDir(root, app), LEDGER_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Append one dry-run call so a later process can inspect what earlier commands would have run.
 * @param {string} root state root
 * @param {string} app app name
 * @param {object} call recorded driver call
 * @returns {object} the call as written
 */
export function appendDryRunCall(root, app, call) {
  assertRecordIsSecretFree(call, "dry-run trace");
  const dir = appStateDir(root, app);
  ensureDir(dir);
  appendFileSync(join(dir, DRYRUN_FILE), JSON.stringify(call) + "\n");
  return call;
}

/**
 * Read the dry-run trace.
 * @param {string} root state root
 * @param {string} app app name
 * @returns {object[]} recorded calls in write order
 */
export function readDryRunCalls(root, app) {
  const file = join(appStateDir(root, app), DRYRUN_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Append one domain-provider request, redacted, to the app's domain log.
 * @param {string} root state root
 * @param {string} app app name
 * @param {object} request redacted request description
 * @returns {object} the record as written
 */
export function appendDomainRequest(root, app, request) {
  const record = { at: new Date().toISOString(), ...request };
  assertRecordIsSecretFree(record, "domain request");
  const dir = appStateDir(root, app);
  ensureDir(dir);
  appendFileSync(join(dir, DOMAINS_FILE), JSON.stringify(record) + "\n");
  return record;
}

/**
 * Read the domain-provider request log.
 * @param {string} root state root
 * @param {string} app app name
 * @returns {object[]} records in write order
 */
export function readDomainRequests(root, app) {
  const file = join(appStateDir(root, app), DOMAINS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/**
 * Collect every host port already claimed by any app in the state root.
 * WHY: a preview must never be published on the port production is already listening on, and
 * the claim is durable across processes, so it is read back from the state root.
 * @param {string} root state root
 * @returns {{ port: number, app: string, env: string }[]} claimed ports
 */
export function claimedPorts(root) {
  const abs = resolve(root);
  if (!existsSync(abs)) return [];
  const claimed = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(abs, entry.name, STATE_FILE);
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    for (const [env, detail] of Object.entries(parsed.envs ?? {})) {
      if (detail && typeof detail.port === "number") {
        claimed.push({ port: detail.port, app: entry.name, env });
      }
    }
  }
  return claimed;
}

/**
 * Allocate a host port that no recorded environment claims.
 * @param {{ root: string, preferred: number, reserved?: number[] }} input
 * @returns {number} a free port at or above the preferred one
 */
export function allocatePort({ root, preferred, reserved = [] }) {
  const taken = new Set([
    ...claimedPorts(root).map((entry) => entry.port),
    ...reserved,
  ]);
  let port = preferred;
  while (taken.has(port) && port < 65535) port += 1;
  return port;
}
