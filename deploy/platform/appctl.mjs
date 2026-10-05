#!/usr/bin/env node
/**
 * appctl - the Layer 4 app-hosting runtime.
 *
 * WHY a CLI and a library: this is the command an operator runs and the command a scheduler can
 * call, and every command answers with one JSON document under --json so a pipeline never has to
 * scrape prose. WHY --driver dry-run exists: it prints and records the exact argv the container
 * runtime would receive, so a plan can be reviewed, and so the test suite proves the lifecycle
 * without a daemon, an image or a network.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_VOLUME_GB, loadManifest } from "./appctl/manifest.mjs";
import {
  appendDryRunCall,
  readAppState,
  resolveStateRoot,
  writeAppState,
} from "./appctl/state.mjs";
import { resolveDriver } from "./appctl/drivers.mjs";
import {
  bindDomain,
  buildImage,
  deployEnvironment,
  destroyEnvironment,
  environmentKey,
  imageRepository,
  logsApp,
  planDeployment,
  promoteEnvironment,
  rollbackEnvironment,
  statusApp,
} from "./appctl/lifecycle.mjs";

/** Commands this runtime implements. */
export const COMMANDS = [
  "plan",
  "build",
  "deploy",
  "promote",
  "rollback",
  "status",
  "logs",
  "destroy",
  "bind-domain",
];
/** Commands that write state or touch a runtime, and therefore persist the state file. */
const MUTATING = new Set([
  "build",
  "deploy",
  "promote",
  "rollback",
  "destroy",
  "bind-domain",
]);

const USAGE = `appctl <command> [options]

Commands
  plan                     print the steps a deploy would take, without touching anything
  build                    build the app image and record its digest
  deploy [--preview]       create or update an environment (preview uses <app>-preview)
  promote --from --to      re-tag and run the exact digest another environment ran
  rollback [--env] [--to]  run a previously recorded digest again
  status                   recorded environments next to what the runtime reports
  logs [--tail N]          container logs
  destroy [--all]          stop and remove containers
  bind-domain --hostname   bind a manifest-declared hostname through its provider

Options
  --manifest <path>        manifest file (default: ./chronograph.app.json)
  --driver docker|dry-run  runtime driver (default: auto-detect docker or podman)
  --dry-run                shorthand for --driver dry-run
  --state-dir <path>       state root (default: $CHRONOGRAPH_APPCTL_STATE_DIR or ./.appctl)
  --env <name>             environment for this command (default: production)
  --preview                deploy into <app>-preview on its own host port
  --port <n>               publish on this host port
  --size-gb <n>            request a volume size; the manifest's sizeGb is the ceiling
  --image <digest>         deploy this digest instead of building
  --no-build               deploy the latest recorded build
  --simulate healthy|unhealthy|flaky   dry-run health outcome
  --health-timeout <ms>    health deadline (default: 60000)
  --health-interval <ms>   health poll interval (default: 1000)
  --tail <n>               log lines to fetch (default: 100)
  --purge-volume           destroy: also delete the named volume
  --hostname <name>        bind-domain target, must be declared in the manifest
  --zone <id>              domain provider zone (overrides the manifest's zone reference)
  --actor <name>           recorded in the ledger (default: $CHRONOGRAPH_ACTOR or $USER)
  --json                   machine-readable output
  --help                   this text
`;

/** A command line that cannot be interpreted. */
class CliError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description
   */
  constructor(code, message) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = 2;
  }
}

/**
 * Parse `--flag value`, `--flag=value` and boolean `--flag`.
 * @param {string[]} argv arguments after the command name
 * @returns {Record<string, string|boolean>}
 */
export function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      throw new CliError("usage", 'unexpected argument "' + token + '"');
    }
    const equals = token.indexOf("=");
    if (equals > 0) {
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}

function intFlag(flags, name, label) {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  if (raw === true) throw new CliError("usage", "--" + name + " needs a value");
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(value)) {
    throw new CliError(
      "usage",
      "--" +
        name +
        " must be an integer, got " +
        JSON.stringify(raw) +
        " (" +
        label +
        ")",
    );
  }
  return value;
}

function optionsFrom(flags) {
  const driver =
    flags["dry-run"] === true ? "dry-run" : (flags.driver ?? "auto");
  const simulate = flags.simulate ?? "healthy";
  if (!["healthy", "unhealthy", "flaky"].includes(String(simulate))) {
    throw new CliError(
      "usage",
      '--simulate must be "healthy", "unhealthy" or "flaky"',
    );
  }
  return {
    json: flags.json === true,
    manifest: typeof flags.manifest === "string" ? flags.manifest : undefined,
    driver: String(driver),
    runtime: typeof flags.runtime === "string" ? flags.runtime : undefined,
    stateDir:
      typeof flags["state-dir"] === "string" ? flags["state-dir"] : undefined,
    env: typeof flags.env === "string" ? flags.env : undefined,
    preview: flags.preview === true || flags.env === "preview",
    from: typeof flags.from === "string" ? flags.from : undefined,
    to: typeof flags.to === "string" ? flags.to : undefined,
    image: typeof flags.image === "string" ? flags.image : undefined,
    hostPort: intFlag(flags, "port"),
    sizeGb: intFlag(flags, "size-gb"),
    build: flags["no-build"] === true ? false : true,
    simulate: String(simulate),
    healthTimeoutMs: intFlag(flags, "health-timeout") ?? 60000,
    healthIntervalMs: intFlag(flags, "health-interval") ?? 1000,
    tail: intFlag(flags, "tail") ?? 100,
    purgeVolume: flags["purge-volume"] === true,
    all: flags.all === true,
    hostname: typeof flags.hostname === "string" ? flags.hostname : undefined,
    zone: typeof flags.zone === "string" ? flags.zone : undefined,
    actor: typeof flags.actor === "string" ? flags.actor : undefined,
    maxVolumeGb: intFlag(flags, "max-volume-gb") ?? DEFAULT_MAX_VOLUME_GB,
  };
}

function humanLines(command, payload) {
  const lines = [];
  if (command === "plan") {
    lines.push(
      "plan " +
        payload.app +
        " -> " +
        payload.env +
        " on " +
        payload.driver +
        " (" +
        payload.runtime +
        ")",
    );
    for (const step of payload.steps) {
      lines.push(
        "  " +
          step.action +
          (step.argv ? "  " + step.argv.join(" ") : "") +
          (step.note ? "  # " + step.note : ""),
      );
    }
  } else if (command === "logs") {
    for (const line of payload.lines) lines.push(line);
  } else if (command === "status") {
    lines.push("status " + payload.app);
    for (const entry of payload.envs) {
      lines.push(
        "  " +
          entry.env +
          "  running=" +
          entry.running +
          " healthy=" +
          entry.healthy +
          " port=" +
          entry.port +
          " digest=" +
          (entry.digest ?? "-"),
      );
    }
  } else if (command === "destroy") {
    for (const entry of payload.destroyed) {
      lines.push(
        "destroyed " +
          entry.env +
          " (" +
          entry.container +
          ")" +
          (entry.volumePurged
            ? " and purged " + entry.volume
            : entry.volume
              ? " keeping " + entry.volume
              : ""),
      );
    }
  } else {
    lines.push(
      command +
        " " +
        payload.app +
        (payload.env ? " " + payload.env : "") +
        (payload.digest ? " digest=" + payload.digest : ""),
    );
  }
  return lines;
}

function failurePayload(error, command, app, driver) {
  return {
    ok: false,
    command,
    app: app ?? null,
    driver: driver ?? null,
    error: {
      code: error.code ?? "error",
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      ...(error.reference ? { reference: error.reference } : {}),
    },
    at: new Date().toISOString(),
  };
}

/**
 * Run one appctl command line.
 * @param {string[]} argv arguments after the node binary and script path
 * @param {{ env?: Record<string, string|undefined>, cwd?: string, stdout?: (line: string) => void, stderr?: (line: string) => void, now?: () => Date }} [io]
 * @returns {Promise<{ exitCode: number, payload: object }>}
 */
export async function runCli(argv = [], io = {}) {
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  const write = io.stdout ?? ((line) => console.log(line));
  const writeError = io.stderr ?? ((line) => console.error(line));
  const now = io.now ?? (() => new Date());

  if (argv[0] === "--help" || argv[0] === "-h" || argv.length === 0) {
    write(USAGE);
    return { exitCode: 0, payload: { ok: true, command: "help" } };
  }
  const [command, ...rest] = argv;
  // WHY the JSON flag is sniffed before parsing: a usage error must still answer a machine with
  // a JSON document, and that failure can happen before the flags themselves are trustworthy.
  const emitFailure = (error, app = null, driverId = null) => {
    const payload = failurePayload(error, command ?? null, app, driverId);
    if (rest.includes("--json") || flags?.json === true)
      write(JSON.stringify(payload));
    else {
      writeError("error: " + error.message);
      if (error instanceof CliError && error.code === "usage")
        writeError(USAGE);
    }
    return { exitCode: error.exitCode ?? 2, payload };
  };
  let flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    return emitFailure(error);
  }
  if (flags.help) {
    write(USAGE);
    return { exitCode: 0, payload: { ok: true, command: "help" } };
  }
  if (!COMMANDS.includes(command)) {
    return emitFailure(
      new CliError(
        "unknown-command",
        'unknown command "' +
          command +
          '"; known commands are ' +
          COMMANDS.join(", "),
      ),
    );
  }

  let options;
  let manifest;
  let driver = null;
  let state = null;
  let stateRoot = null;
  const dryRunCalls = [];
  try {
    options = optionsFrom(flags);
    const manifestPath =
      options.manifest ??
      env.CHRONOGRAPH_APP_MANIFEST ??
      resolve(cwd, "chronograph.app.json");
    manifest = loadManifest(manifestPath, { maxVolumeGb: options.maxVolumeGb });
    stateRoot = resolveStateRoot({ flag: options.stateDir, env, cwd });
    state = readAppState(stateRoot, manifest.name);
    const wantDryRun = options.driver === "dry-run";
    const resolved = await resolveDriver({
      driver: options.driver,
      simulate: options.simulate,
      app: manifest.name,
      runtime: options.runtime,
      world: { envs: state.envs, volumes: state.volumes },
      onCall: (call) => {
        dryRunCalls.push(call);
        // Recording every dry-run argv on disk is what lets a later command (promote after
        // deploy, for example) be inspected by an operator or asserted by a test.
        if (wantDryRun) appendDryRunCall(stateRoot, manifest.name, call);
      },
    });
    driver = resolved.driver;
    const context = {
      env,
      actor: options.actor ?? env.CHRONOGRAPH_ACTOR ?? env.USER ?? "unknown",
      now,
      healthTimeoutMs: options.healthTimeoutMs,
      healthIntervalMs: options.healthIntervalMs,
      maxVolumeGb: options.maxVolumeGb,
    };
    const base = {
      manifest,
      driver,
      stateRoot,
      state,
      options: { ...options, stateRoot },
      context,
    };
    const mutated = MUTATING.has(command);
    const finish = (payload) => {
      if (mutated) writeAppState(stateRoot, manifest.name, state);
      const document = {
        ok: true,
        command,
        app: manifest.name,
        driver: driver.id,
        runtime: driver.runtime,
        manifest: manifest.manifestPath,
        actor: context.actor,
        at: now().toISOString(),
        ...payload,
      };
      if (driver.id === "dry-run") document.dryRunCalls = dryRunCalls;
      if (options.json) {
        write(JSON.stringify(document));
      } else {
        for (const line of humanLines(command, document)) write(line);
      }
      return { exitCode: 0, payload: document };
    };

    if (command === "plan") {
      return finish(planDeployment(base));
    }
    if (command === "build") {
      const tag =
        imageRepository(manifest.name) +
        ":" +
        environmentKey(manifest.name, options);
      const built = await buildImage({ ...base, tag });
      return finish({
        env: environmentKey(manifest.name, options),
        tag: built.tag,
        digest: built.digest,
        calls: [built.argv],
      });
    }
    if (command === "deploy") {
      return finish(await deployEnvironment(base));
    }
    if (command === "promote") {
      return finish(await promoteEnvironment(base));
    }
    if (command === "rollback") {
      return finish(await rollbackEnvironment(base));
    }
    if (command === "status") {
      return finish(await statusApp(base));
    }
    if (command === "logs") {
      return finish(await logsApp(base));
    }
    if (command === "destroy") {
      return finish(await destroyEnvironment(base));
    }
    if (command === "bind-domain") {
      return finish(await bindDomain(base));
    }
    throw new CliError("unknown-command", "unknown command " + command);
  } catch (error) {
    // A refused or failed mutation still has state worth keeping - notably the tombstone a
    // failed deploy writes so promotion can see that the preview never became healthy.
    if (stateRoot && manifest && state && MUTATING.has(command)) {
      try {
        writeAppState(stateRoot, manifest.name, state);
      } catch {
        // Best effort: the failure being reported matters more than a bookkeeping error.
      }
    }
    const exitCode = error.exitCode ?? 1;
    const payload = failurePayload(
      error,
      command,
      manifest?.name ?? null,
      driver?.id ?? null,
    );
    if (driver?.id === "dry-run") payload.dryRunCalls = dryRunCalls;
    if (options?.json) {
      write(JSON.stringify(payload));
    } else {
      writeError("error: " + error.message);
    }
    return { exitCode, payload };
  }
}

/**
 * Emit the usage text for a caller that only wants the interface.
 * @returns {string} usage text
 */
export function usage() {
  return USAGE;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
