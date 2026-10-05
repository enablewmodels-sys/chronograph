/**
 * Manifest loading and strict validation for Layer 4 app hosting.
 *
 * WHY this is strict: a manifest decides what image is built, which persistent volume a
 * database writes into and which hostname is published, so a bad manifest has to be refused
 * before the container runtime is touched rather than half-applied. WHY credentials are
 * refused here: appctl keeps a state file and an append-only ledger on disk, and anything
 * accepted in this file ends up copied into them, so a credential may only ever appear as an
 * environment variable NAME.
 */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, resolve, sep } from "node:path";

/** Manifest schema version this build understands. */
export const MANIFEST_VERSION = 1;
/** Application kinds the runtime knows how to host. */
export const APP_KINDS = ["container", "web", "mobile"];
/** Domain providers with an adapter in `domains.mjs`. */
export const DOMAIN_PROVIDERS = ["cloudflare-saas"];
/** Store targets a mobile build may declare. Publishing stays with the operator. */
export const STORE_TARGETS = ["play", "app-store"];
/** How an environment variable is supplied to the container. */
export const ENV_KINDS = ["plain", "secret-ref"];
/** Hard ceiling for a single named volume; above this the operator is using the wrong tool. */
export const DEFAULT_MAX_VOLUME_GB = 2048;

const TOP_LEVEL_KEYS = new Set([
  "version",
  "name",
  "kind",
  "build",
  "run",
  "persistence",
  "domains",
  "env",
  "stores",
  "boundary",
]);
const BUILD_KEYS = new Set(["context", "dockerfile"]);
const RUN_KEYS = new Set(["port", "health", "replicas"]);
const PERSISTENCE_KEYS = new Set(["mount", "sizeGb", "note"]);
const DOMAIN_KEYS = new Set(["hostname", "provider", "env", "zone"]);
const ENV_KEYS = new Set(["name", "kind", "value"]);
const STORE_KEYS = new Set(["store", "artifact", "requires"]);

const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HOSTNAME =
  /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
// A database-like variable name is evidence that the app keeps state, so a container that
// declares one without persistence is the serverless mistake this layer exists to avoid.
const DATABASE_LIKE_ENV =
  /(^|_)(DB|DATABASE|POSTGRES|POSTGRESQL|MYSQL|MARIADB|MONGO|MONGODB|REDIS|SQLITE|NEO4J|CASSANDRA|CLICKHOUSE|TIMESCALE|INFLUX|DSN)(_|$)|_DSN$/;
const CREDENTIAL_LIKE_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|BEARER)/;

// Named patterns, not one catch-all: the label is safe to print in an error message while the
// matched value never is.
const SECRET_PATTERNS = [
  { label: "stripe-secret-key", pattern: /sk_(?:live|test)_[A-Za-z0-9]{8,}/ },
  { label: "stripe-webhook-secret", pattern: /whsec_[A-Za-z0-9]{8,}/ },
  { label: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{8,}/ },
  {
    label: "github-token",
    pattern: /(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  },
  { label: "aws-access-key-id", pattern: /AKIA[0-9A-Z]{16}/ },
  { label: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    label: "json-web-token",
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  },
];

/** A manifest or a ledger record that cannot be applied. */
export class ManifestError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description, never containing a secret value
   */
  constructor(code, message) {
    super(message);
    this.name = "ManifestError";
    this.code = code;
    this.exitCode = 1;
  }
}

/**
 * Name the credential a string is shaped like, without returning the string itself.
 * @param {unknown} value
 * @returns {string|null} pattern label, or null when nothing matched
 */
export function findSecretLiteral(value) {
  if (typeof value !== "string") return null;
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

/**
 * Report whether a literal looks like an opaque credential.
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeOpaqueToken(value) {
  if (typeof value !== "string" || value.length < 32) return false;
  // A digest is a public identifier, so a pure hex string is deliberately exempt.
  if (/^[0-9a-f]{32,}$/i.test(value)) return false;
  // URLs, paths and image refs carry punctuation and are configuration, not credentials.
  if (/[:/.@\s,]/.test(value)) return false;
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}

/**
 * Throw when a literal is a credential, quoting the pattern rather than the value.
 * @param {unknown} value
 * @param {string} where description used in the error message
 * @returns {void}
 */
export function assertNoSecretLiteral(value, where) {
  const label = findSecretLiteral(value);
  if (label) {
    throw new ManifestError(
      "credential-in-manifest",
      where +
        " carries what looks like a " +
        label +
        "; store the value in the environment and reference only its variable name",
    );
  }
  if (looksLikeOpaqueToken(value)) {
    throw new ManifestError(
      "credential-in-manifest",
      where +
        " carries an opaque token-shaped literal; store the value in the environment and reference only its variable name",
    );
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, code, label) {
  if (!isRecord(value)) {
    throw new ManifestError(code, label + " must be an object");
  }
  return value;
}

function requireKeys(object, allowed, code, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new ManifestError(code, 'unknown key "' + key + '" in ' + label);
    }
  }
}

/**
 * Validate an already-parsed manifest, returning a normalized copy.
 * @param {unknown} raw parsed manifest JSON
 * @param {{ manifestPath?: string, maxVolumeGb?: number, allowedContextRoots?: string[] }} [options]
 * @returns {object} normalized manifest
 */
export function validateManifest(raw, options = {}) {
  const manifestPath = options.manifestPath ?? "<memory>";
  const maxVolumeGb = options.maxVolumeGb ?? DEFAULT_MAX_VOLUME_GB;
  const where = "manifest " + manifestPath;
  requireRecord(raw, "manifest-shape", where);
  requireKeys(raw, TOP_LEVEL_KEYS, "unknown-key", where);

  if (raw.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      "manifest-version",
      where +
        " declares version " +
        String(raw.version) +
        ", this runtime speaks version " +
        MANIFEST_VERSION,
    );
  }
  if (typeof raw.name !== "string" || !APP_NAME.test(raw.name)) {
    throw new ManifestError(
      "app-name",
      where +
        " needs a name matching " +
        APP_NAME.source +
        " (it becomes a container and volume name)",
    );
  }
  if (!APP_KINDS.includes(raw.kind)) {
    throw new ManifestError(
      "unknown-kind",
      where +
        ' declares kind "' +
        String(raw.kind) +
        '"; known kinds are ' +
        APP_KINDS.join(", "),
    );
  }
  if (raw.boundary !== undefined) {
    if (typeof raw.boundary !== "string") {
      throw new ManifestError("boundary", where + " boundary must be a string");
    }
    assertNoSecretLiteral(raw.boundary, where + " boundary");
  }

  const build = requireRecord(raw.build, "build-shape", where + " build");
  requireKeys(build, BUILD_KEYS, "unknown-key", where + " build");
  if (typeof build.context !== "string" || build.context.trim() === "") {
    throw new ManifestError(
      "build-context",
      where + " build.context must be a path",
    );
  }
  if (typeof build.dockerfile !== "string" || build.dockerfile.trim() === "") {
    throw new ManifestError(
      "build-dockerfile",
      where + " build.dockerfile must be a file name",
    );
  }
  if (
    isAbsolute(build.dockerfile) ||
    build.dockerfile.split("/").includes("..")
  ) {
    throw new ManifestError(
      "build-dockerfile",
      where + " build.dockerfile must stay inside the build context",
    );
  }

    // WHY the context is constrained: the build context is what the runtime streams to the
  // build daemon, and with a remote DOCKER_HOST that leaves the machine. Unconstrained, a
  // manifest could name any host directory — one holding secrets or engine data — and bake
  // it into an image. The context therefore has to sit inside the manifest's own directory
  // or inside a root the operator allowlisted in CHRONOGRAPH_APP_CONTEXT_ROOTS.
  if (manifestPath !== "<memory>") {
    // Both sides are compared as real paths: a deployment directory is often reached through
    // a symlink (macOS /var -> /private/var, for one), so comparing a resolved path with a
    // canonical root would refuse a manifest that is perfectly inside its own directory.
    const real = (candidate) => {
      try {
        return realpathSync(candidate);
      } catch {
        // A path that does not exist yet cannot have been reached through a symlink; the
        // runtime refuses a missing context, which is not this check's job.
        return resolve(candidate);
      }
    };
    const manifestDirectory = real(dirname(resolve(manifestPath)));
    const contextPath = real(resolve(dirname(resolve(manifestPath)), build.context));
    const allowed = [manifestDirectory, ...(options.allowedContextRoots ?? []).map(real)];
    const inside = allowed.some(
      (root) => contextPath === root || contextPath.startsWith(root + sep),
    );
    if (!inside) {
      throw new ManifestError(
        "build-context-outside",
        where +
          " build.context resolves outside the manifest's own directory; keep the context" +
          " beside the manifest or list its root in CHRONOGRAPH_APP_CONTEXT_ROOTS",
      );
    }
  }

const run = requireRecord(raw.run, "run-shape", where + " run");
  requireKeys(run, RUN_KEYS, "unknown-key", where + " run");
  if (!Number.isInteger(run.port) || run.port <= 0 || run.port > 65535) {
    throw new ManifestError(
      "invalid-port",
      where +
        ' run.port must be an integer between 1 and 65535 (port 0 would mean "any free port", which cannot be health-checked or bound)',
    );
  }
  if (typeof run.health !== "string" || !run.health.startsWith("/")) {
    throw new ManifestError(
      "invalid-health-path",
      where +
        " run.health must be an absolute path such as /healthz; a deployment without a health check cannot be promoted",
    );
  }
  assertNoSecretLiteral(run.health, where + " run.health");
  const replicas = run.replicas ?? 1;
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new ManifestError(
      "invalid-replicas",
      where + " run.replicas must be an integer >= 1",
    );
  }

  let persistence = null;
  if (raw.persistence !== undefined) {
    const declared = requireRecord(
      raw.persistence,
      "persistence-shape",
      where + " persistence",
    );
    requireKeys(
      declared,
      PERSISTENCE_KEYS,
      "unknown-key",
      where + " persistence",
    );
    if (typeof declared.mount !== "string" || !isAbsolute(declared.mount)) {
      throw new ManifestError(
        "relative-mount",
        where +
          " persistence.mount must be an absolute path inside the container, such as /data",
      );
    }
    if (!Number.isInteger(declared.sizeGb) || declared.sizeGb < 1) {
      throw new ManifestError(
        "invalid-volume-size",
        where + " persistence.sizeGb must be an integer >= 1",
      );
    }
    if (declared.sizeGb > maxVolumeGb) {
      throw new ManifestError(
        "volume-too-large",
        where +
          " persistence.sizeGb is " +
          declared.sizeGb +
          ", above the " +
          maxVolumeGb +
          "GB ceiling for one host volume",
      );
    }
    if (declared.note !== undefined) {
      if (typeof declared.note !== "string") {
        throw new ManifestError(
          "persistence-note",
          where + " persistence.note must be a string",
        );
      }
      assertNoSecretLiteral(declared.note, where + " persistence.note");
    }
    persistence = {
      mount: declared.mount,
      sizeGb: declared.sizeGb,
      note: declared.note ?? "",
    };
  }

  const environment = [];
  if (raw.env !== undefined) {
    if (!Array.isArray(raw.env)) {
      throw new ManifestError("env-shape", where + " env must be an array");
    }
    const seen = new Set();
    for (const entry of raw.env) {
      const variable = requireRecord(entry, "env-shape", where + " env entry");
      requireKeys(variable, ENV_KEYS, "unknown-key", where + " env entry");
      if (
        typeof variable.name !== "string" ||
        !IDENTIFIER.test(variable.name)
      ) {
        throw new ManifestError(
          "env-name",
          where +
            " env entry needs a POSIX-style variable name, got " +
            JSON.stringify(variable.name),
        );
      }
      if (seen.has(variable.name)) {
        throw new ManifestError(
          "env-duplicate",
          where + " declares " + variable.name + " twice",
        );
      }
      seen.add(variable.name);
      if (!ENV_KINDS.includes(variable.kind)) {
        throw new ManifestError(
          "env-kind",
          where +
            " env." +
            variable.name +
            ' must be kind "plain" or "secret-ref"',
        );
      }
      if (variable.kind === "secret-ref") {
        if (variable.value !== undefined) {
          throw new ManifestError(
            "credential-in-manifest",
            where +
              " env." +
              variable.name +
              " is a secret-ref and must not carry a value",
          );
        }
      } else {
        // A plain value is allowed for configuration; a credential name never is.
        if (variable.value !== undefined) {
          if (typeof variable.value !== "string") {
            throw new ManifestError(
              "env-value",
              where + " env." + variable.name + " value must be a string",
            );
          }
          assertNoSecretLiteral(
            variable.value,
            where + " env." + variable.name,
          );
        }
        if (CREDENTIAL_LIKE_NAME.test(variable.name)) {
          throw new ManifestError(
            "credential-looking-name",
            where +
              " env." +
              variable.name +
              ' is plain but sounds like a credential; declare it as "secret-ref" so the value stays in the environment',
          );
        }
      }
      environment.push({
        name: variable.name,
        kind: variable.kind,
        value:
          variable.kind === "plain" && variable.value !== undefined
            ? variable.value
            : null,
      });
    }
  }

  const databaseLike = environment
    .map((variable) => variable.name)
    .filter(
      (name) =>
        DATABASE_LIKE_ENV.test(name.toUpperCase()) ||
        DATABASE_LIKE_ENV.test(name),
    );
  // WHY: a container that talks to a database keeps state, so it must never be deployed
  // without a durable volume - that is the whole difference from a serverless host.
  if (
    raw.kind === "container" &&
    databaseLike.length > 0 &&
    persistence === null
  ) {
    throw new ManifestError(
      "persistence-required",
      where +
        " is a container with database-like variables (" +
        databaseLike.join(", ") +
        ") but declares no persistence block; a stateful app needs a durable mount",
    );
  }

  const domains = [];
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains)) {
      throw new ManifestError(
        "domains-shape",
        where + " domains must be an array",
      );
    }
    const seen = new Set();
    for (const entry of raw.domains) {
      const domain = requireRecord(
        entry,
        "domains-shape",
        where + " domain entry",
      );
      requireKeys(domain, DOMAIN_KEYS, "unknown-key", where + " domain entry");
      if (
        typeof domain.hostname !== "string" ||
        !HOSTNAME.test(domain.hostname)
      ) {
        throw new ManifestError(
          "domain-hostname",
          where +
            " domain hostname " +
            JSON.stringify(domain.hostname) +
            " is not a valid DNS name",
        );
      }
      if (seen.has(domain.hostname)) {
        throw new ManifestError(
          "domain-duplicate",
          where + " declares " + domain.hostname + " twice",
        );
      }
      seen.add(domain.hostname);
      if (!DOMAIN_PROVIDERS.includes(domain.provider)) {
        throw new ManifestError(
          "domain-provider",
          where +
            " domain " +
            domain.hostname +
            " names provider " +
            JSON.stringify(domain.provider) +
            "; known providers are " +
            DOMAIN_PROVIDERS.join(", "),
        );
      }
      const refs = domain.env ?? [];
      if (
        !Array.isArray(refs) ||
        refs.some((name) => typeof name !== "string" || !IDENTIFIER.test(name))
      ) {
        throw new ManifestError(
          "domain-env",
          where +
            " domain " +
            domain.hostname +
            " env must list environment variable names (references only, never values)",
        );
      }
      if (
        domain.zone !== undefined &&
        (typeof domain.zone !== "string" || domain.zone === "")
      ) {
        throw new ManifestError(
          "domain-zone",
          where +
            " domain " +
            domain.hostname +
            " zone must be a non-empty string",
        );
      }
      domains.push({
        hostname: domain.hostname,
        provider: domain.provider,
        env: [...refs],
        zone: domain.zone ?? null,
      });
    }
  }

  const stores = [];
  if (raw.stores !== undefined) {
    if (!Array.isArray(raw.stores)) {
      throw new ManifestError(
        "stores-shape",
        where + " stores must be an array",
      );
    }
    for (const entry of raw.stores) {
      const store = requireRecord(
        entry,
        "stores-shape",
        where + " store entry",
      );
      requireKeys(store, STORE_KEYS, "unknown-key", where + " store entry");
      if (!STORE_TARGETS.includes(store.store)) {
        throw new ManifestError(
          "store-target",
          where +
            " store target " +
            JSON.stringify(store.store) +
            " is unknown; known targets are " +
            STORE_TARGETS.join(", "),
        );
      }
      if (
        typeof store.artifact !== "string" ||
        store.artifact === "" ||
        store.artifact.startsWith("/") ||
        store.artifact.split("/").includes("..")
      ) {
        throw new ManifestError(
          "store-artifact",
          where +
            " store " +
            store.store +
            " artifact must be a relative file name",
        );
      }
      if (typeof store.requires !== "string" || store.requires === "") {
        throw new ManifestError(
          "store-requires",
          where +
            " store " +
            store.store +
            " must state what the operator supplies",
        );
      }
      stores.push({
        store: store.store,
        artifact: store.artifact,
        requires: store.requires,
      });
    }
  }
  if (raw.kind === "mobile" && stores.length === 0) {
    throw new ManifestError(
      "stores-required",
      where +
        " is a mobile app and must name its store artifacts (play, app-store)",
    );
  }

  const baseDir = dirname(resolve(manifestPath));
  return {
    version: MANIFEST_VERSION,
    name: raw.name,
    kind: raw.kind,
    boundary: raw.boundary ?? "",
    build: {
      context: resolve(baseDir, build.context),
      contextRef: build.context,
      dockerfile: build.dockerfile,
    },
    run: { port: run.port, health: run.health, replicas },
    persistence,
    domains,
    env: environment,
    stores,
    databaseLikeEnv: databaseLike,
  };
}

/**
 * Load a manifest from disk, refusing credential-shaped text before parsing.
 * @param {string} manifestPath path to chronograph.app.json or an equivalent file
 * @param {{ maxVolumeGb?: number }} [options]
 * @returns {object} normalized manifest with manifestPath and manifestHash
 */
export function loadManifest(manifestPath, options = {}) {
  const absolute = resolve(manifestPath);
  // Operator-configured allowlist for build contexts that legitimately live outside the
  // manifest's directory (a checkout beside it, for example). Read from the environment so a
  // deployment sets it once; nothing in a request can widen it.
  const allowedContextRoots = (
    options.allowedContextRoots ??
    (process.env.CHRONOGRAPH_APP_CONTEXT_ROOTS ?? "").split(delimiter)
  ).filter(Boolean);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    throw new ManifestError(
      "manifest-missing",
      "cannot read manifest " + absolute + ": " + (error.code ?? error.message),
    );
  }
  // WHY only pattern-shaped credentials are scanned in the raw text: a manifest legitimately
  // holds digests, URLs and long identifiers, so a catch-all entropy scan here would reject
  // those while catching nothing that the per-value checks below do not already catch.
  const label = findSecretLiteral(text);
  if (label) {
    throw new ManifestError(
      "credential-in-manifest",
      "manifest " +
        absolute +
        " contains what looks like a " +
        label +
        "; reference it by variable name instead",
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ManifestError(
      "manifest-json",
      "manifest " + absolute + " is not valid JSON: " + error.message,
    );
  }
  const manifest = validateManifest(raw, {
    manifestPath: absolute,
    ...options,
    allowedContextRoots,
  });
  manifest.manifestPath = absolute;
  manifest.manifestHash = createHash("sha256").update(text).digest("hex");
  return manifest;
}

/**
 * Find the declared domain entry for a hostname.
 * @param {object} manifest normalized manifest
 * @param {string} hostname
 * @returns {object|null}
 */
export function findDomain(manifest, hostname) {
  return manifest.domains.find((entry) => entry.hostname === hostname) ?? null;
}

/**
 * Split a domain entry's environment references into the ones each adapter needs.
 * @param {object} entry domain entry
 * @returns {{ tokenRef: string|null, zoneRef: string|null }}
 */
export function domainRefs(entry) {
  const refs = entry.env ?? [];
  const tokenRef = refs.find((name) => /(TOKEN|KEY|SECRET)/.test(name)) ?? null;
  const zoneRef = refs.find((name) => /ZONE/.test(name)) ?? null;
  return { tokenRef, zoneRef };
}
