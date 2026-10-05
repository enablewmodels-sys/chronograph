/**
 * Container-runtime drivers for Layer 4 app hosting.
 *
 * WHY the argv is built in one place: the dry-run driver has to record the exact command the
 * docker driver would execute, so both call `argvFor` and neither can drift from the other.
 * The docker driver is a thin shell over docker or podman; every decision that matters (volume
 * size, published port, which environment variables carry values) is made in the task object.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";

/** Runtimes appctl knows how to drive, in preference order. */
export const RUNTIMES = ["docker", "podman"];

function assertArgv(argv) {
  for (const arg of argv) {
    if (typeof arg !== "string" || arg === "") {
      throw new Error(
        "refusing to run an argv with an empty argument: " +
          JSON.stringify(argv),
      );
    }
  }
  return argv;
}

/**
 * @param {object} input
 * @returns {object} task describing `docker volume create`
 */
export function volumeCreateTask(input) {
  return {
    kind: "volume-create",
    runtime: input.runtime,
    app: input.app,
    env: input.env,
    name: input.name,
    sizeGb: input.sizeGb,
  };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker volume rm`
 */
export function volumeRemoveTask(input) {
  return { kind: "volume-remove", runtime: input.runtime, name: input.name };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker volume inspect`
 */
export function volumeInspectTask(input) {
  return { kind: "volume-inspect", runtime: input.runtime, name: input.name };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker build`
 */
export function buildTask(input) {
  return {
    kind: "build",
    runtime: input.runtime,
    app: input.app,
    tag: input.tag,
    context: input.context,
    dockerfile: input.dockerfile,
    buildIndex: input.buildIndex ?? 0,
    manifestHash: input.manifestHash ?? "",
  };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker image inspect`
 */
export function imageInspectTask(input) {
  return { kind: "image-inspect", runtime: input.runtime, tag: input.tag };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker run`
 */
export function runTask(input) {
  return {
    kind: "run",
    runtime: input.runtime,
    name: input.name,
    image: input.image,
    envFlags: input.envFlags ?? [],
    volume: input.volume,
    mount: input.mount,
    port: input.port,
    hostPort: input.hostPort,
    labels: { "chronograph.managed-by": "appctl", ...(input.labels ?? {}) },
  };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker stop`
 */
export function stopTask(input) {
  return { kind: "stop", runtime: input.runtime, name: input.name };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker rm -f`
 */
export function rmTask(input) {
  return { kind: "rm", runtime: input.runtime, name: input.name };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker inspect`
 */
export function inspectTask(input) {
  return { kind: "inspect", runtime: input.runtime, name: input.name };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker logs --tail`
 */
export function logsTask(input) {
  return {
    kind: "logs",
    runtime: input.runtime,
    name: input.name,
    tail: input.tail,
  };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker ps`
 */
export function psTask(input) {
  return { kind: "ps", runtime: input.runtime };
}

/**
 * @param {object} input
 * @returns {object} task describing `docker tag`, used to re-tag a promoted digest
 */
export function tagTask(input) {
  return {
    kind: "tag",
    runtime: input.runtime,
    source: input.source,
    target: input.target,
  };
}

/**
 * Turn a task into the argv the runtime would receive.
 * @param {object} task task from one of the constructors above
 * @returns {string[]} argv, argv[0] being the runtime binary
 */
export function argvFor(task) {
  const runtime = task.runtime ?? "docker";
  switch (task.kind) {
    case "volume-create":
      // WHY labels: docker's volume API has no portable size option (sizing is driver
      // specific), so the declared size is written as a label and verified back on inspect -
      // appctl then refuses any later request that would exceed what the manifest declares.
      return assertArgv([
        runtime,
        "volume",
        "create",
        "--label",
        "chronograph.appctl=" + task.app,
        "--label",
        "chronograph.env=" + task.env,
        "--label",
        "chronograph.size-gb=" + task.sizeGb,
        task.name,
      ]);
    case "volume-remove":
      return assertArgv([runtime, "volume", "rm", task.name]);
    case "volume-inspect":
      return assertArgv([
        runtime,
        "volume",
        "inspect",
        "--format",
        "{{json .Labels}}",
        task.name,
      ]);
    case "build":
      return assertArgv([
        runtime,
        "build",
        "-t",
        task.tag,
        "-f",
        task.dockerfile,
        task.context,
      ]);
    case "image-inspect":
      return assertArgv([
        runtime,
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        task.tag,
      ]);
    case "run": {
      // WHY the port is published on 127.0.0.1 only: the public path is the domain provider or
      // the local Caddy proxy in front of it, and binding 0.0.0.0 by default would expose an
      // app that has no TLS and no auth of its own.
      const argv = [
        runtime,
        "run",
        "-d",
        "--name",
        task.name,
        "--restart",
        "unless-stopped",
        "-p",
        "127.0.0.1:" + task.hostPort + ":" + task.port,
      ];
      // A web or mobile app may legitimately declare no persistence; a container with
      // database-like variables cannot (validation refuses it first).
      if (task.volume && task.mount) {
        argv.push(
          "--mount",
          "type=volume,src=" + task.volume + ",dst=" + task.mount,
        );
      }
      for (const [key, value] of Object.entries(task.labels)) {
        argv.push("--label", key + "=" + value);
      }
      for (const flag of task.envFlags) {
        argv.push("-e", flag);
      }
      argv.push(task.image);
      return assertArgv(argv);
    }
    case "stop":
      return assertArgv([runtime, "stop", task.name]);
    case "rm":
      return assertArgv([runtime, "rm", "-f", task.name]);
    case "inspect":
      return assertArgv([
        runtime,
        "inspect",
        "--format",
        "{{json .State}}",
        task.name,
      ]);
    case "logs":
      return assertArgv([
        runtime,
        "logs",
        "--tail",
        String(task.tail),
        task.name,
      ]);
    case "ps":
      return assertArgv([runtime, "ps", "--format", "{{json .}}"]);
    case "tag":
      return assertArgv([runtime, "tag", task.source, task.target]);
    default:
      throw new Error("unknown runtime task " + JSON.stringify(task.kind));
  }
}

function digestOf(parts) {
  return "sha256:" + createHash("sha256").update(parts.join(":")).digest("hex");
}

/**
 * Driver that only records argv and returns canned results. Tests use this so no daemon,
 * image or network is needed, and the recorded argv is still the real command.
 * @param {object} input
 * @param {string} input.app app name, used for the state trace
 * @param {string} [input.runtime] runtime name the recorded argv should mention
 * @param {"healthy"|"unhealthy"|"flaky"} [input.simulate] canned health outcome
 * @param {{ envs: Record<string, object>, volumes: Record<string, object> }} [input.world] state-backed world
 * @param {(call: object) => void} [input.onCall] sink for recorded calls, usually the dry-run trace
 * @returns {object} driver
 */
export function createDryRunDriver(input) {
  const runtime = input.runtime ?? "docker";
  const simulate = input.simulate ?? "healthy";
  const world = input.world ?? { envs: {}, volumes: {} };
  const calls = [];
  let probes = 0;
  const record = (task, argv, result) => {
    const call = {
      at: new Date().toISOString(),
      kind: task.kind,
      argv,
      result,
    };
    calls.push(call);
    if (input.onCall) input.onCall(call);
    return call;
  };
  const byContainer = (name) =>
    Object.values(world.envs).find((env) => env.container === name) ?? null;
  return {
    id: "dry-run",
    runtime,
    recordedCalls: () => calls,
    async ensureVolume(task) {
      const argv = argvFor(task);
      const existing = world.volumes[task.name] ?? null;
      world.volumes[task.name] = {
        name: task.name,
        sizeGb: task.sizeGb,
        app: task.app,
        env: task.env,
        created: !existing,
      };
      return {
        argv,
        name: task.name,
        created: !existing,
        ...record(task, argv, { name: task.name, created: !existing }),
      };
    },
    async inspectVolume(task) {
      const argv = argvFor(task);
      const existing = world.volumes[task.name] ?? null;
      const result = existing
        ? {
            exists: true,
            sizeGb: existing.sizeGb,
            labels: { "chronograph.size-gb": String(existing.sizeGb) },
          }
        : { exists: false, sizeGb: null, labels: {} };
      return { argv, ...result, ...record(task, argv, result) };
    },
    async removeVolume(task) {
      const argv = argvFor(task);
      delete world.volumes[task.name];
      return { argv, removed: true, ...record(task, argv, { removed: true }) };
    },
    async build(task) {
      const argv = argvFor(task);
      const digest = digestOf([
        task.app,
        task.tag,
        String(task.buildIndex),
        task.manifestHash,
      ]);
      const result = { tag: task.tag, digest, imageId: digest };
      return { argv, ...result, ...record(task, argv, result) };
    },
    async run(task) {
      const argv = argvFor(task);
      const result = {
        id:
          "dryrun-" +
          createHash("sha1").update(task.name).digest("hex").slice(0, 12),
        name: task.name,
      };
      return {
        argv,
        containerId: result.id,
        ...result,
        ...record(task, argv, result),
      };
    },
    async stop(task) {
      const argv = argvFor(task);
      return { argv, stopped: true, ...record(task, argv, { stopped: true }) };
    },
    async rm(task) {
      const argv = argvFor(task);
      return { argv, removed: true, ...record(task, argv, { removed: true }) };
    },
    async tag(task) {
      const argv = argvFor(task);
      return { argv, tagged: true, ...record(task, argv, { tagged: true }) };
    },
    async inspect(task) {
      const argv = argvFor(task);
      const recorded = byContainer(task.name);
      const result = recorded
        ? {
            exists: true,
            running: recorded.running !== false,
            healthy:
              simulate === "healthy" ? recorded.health === "healthy" : false,
            image: recorded.image ?? null,
            digest: recorded.digest ?? null,
            port: recorded.port ?? null,
          }
        : {
            exists: false,
            running: false,
            healthy: false,
            image: null,
            digest: null,
            port: null,
          };
      return { argv, ...result, ...record(task, argv, result) };
    },
    async logs(task) {
      const argv = argvFor(task);
      const all = [
        "dry-run: " + task.name + " starting",
        "dry-run: journal opened",
        "dry-run: listening",
        "dry-run: health endpoint ready",
        "dry-run: idle",
      ];
      const lines = all.slice(Math.max(0, all.length - task.tail));
      return { argv, lines, ...record(task, argv, { lines: lines.length }) };
    },
    async ps(task) {
      const argv = argvFor(task);
      const containers = Object.values(world.envs)
        .filter((env) => env.container)
        .map((env) => ({
          name: env.container,
          running: env.running !== false,
          image: env.image ?? null,
          port: env.port ?? null,
        }));
      return {
        argv,
        containers,
        ...record(task, argv, { containers: containers.length }),
      };
    },
    async probe(target) {
      probes += 1;
      // WHY "flaky": it is the only way to exercise the polling loop without a real app that
      // answers 503 for a few seconds while it opens its journal.
      const failing =
        simulate === "unhealthy" || (simulate === "flaky" && probes < 3);
      const result = failing
        ? {
            ok: false,
            status: 503,
            body: '{"status":"unhealthy","simulated":true}',
          }
        : { ok: true, status: 200, body: '{"status":"ok","simulated":true}' };
      return { ...result, port: target.port, path: target.path };
    },
  };
}

function execFileAsync(argv) {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function probeHttp({ port, path, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path, timeout: timeoutMs },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 512) body += chunk;
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body: body.trim(),
          });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve({
        ok: false,
        status: 0,
        body: "timeout after " + timeoutMs + "ms",
      });
    });
    request.on("error", (error) => {
      resolve({
        ok: false,
        status: 0,
        body: String(error.code ?? error.message),
      });
    });
  });
}

/**
 * Driver that shells out to a real docker or podman binary.
 * @param {{ runtime: string, exec?: (argv: string[]) => Promise<{ code: number, stdout: string, stderr: string }> }} input
 * @returns {object} driver
 */
export function createDockerDriver(input) {
  const runtime = input.runtime;
  const exec = input.exec ?? execFileAsync;
  const run = async (argv) => ({ argv, ...(await exec(argv)) });
  const must = async (argv, what) => {
    const outcome = await run(argv);
    if (outcome.code !== 0) {
      const detail = (outcome.stderr || outcome.stdout)
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ");
      throw new Error(
        runtime + " " + what + " failed (exit " + outcome.code + "): " + detail,
      );
    }
    return outcome;
  };
  return {
    id: "docker",
    runtime,
    async ensureVolume(task) {
      const outcome = await must(argvFor(task), "volume create");
      return { ...outcome, name: task.name, created: true };
    },
    async inspectVolume(task) {
      const outcome = await run(argvFor(task));
      if (outcome.code !== 0)
        return { ...outcome, exists: false, sizeGb: null, labels: {} };
      let labels = {};
      try {
        labels = JSON.parse(outcome.stdout.trim() || "{}");
      } catch {
        labels = {};
      }
      const declared = Number.parseInt(labels["chronograph.size-gb"] ?? "", 10);
      return {
        ...outcome,
        exists: true,
        labels,
        sizeGb: Number.isInteger(declared) ? declared : null,
      };
    },
    async removeVolume(task) {
      const outcome = await run(argvFor(task));
      return { ...outcome, removed: outcome.code === 0 };
    },
    async build(task) {
      const outcome = await must(argvFor(task), "build");
      const inspected = await run(
        argvFor(imageInspectTask({ runtime, tag: task.tag })),
      );
      const imageId = inspected.code === 0 ? inspected.stdout.trim() : "";
      const digest = imageId !== "" ? imageId : "unknown";
      return { ...outcome, tag: task.tag, digest, imageId };
    },
    async run(task) {
      const outcome = await must(argvFor(task), "run");
      return {
        ...outcome,
        containerId: outcome.stdout.trim(),
        name: task.name,
      };
    },
    async stop(task) {
      const outcome = await run(argvFor(task));
      return { ...outcome, stopped: outcome.code === 0 };
    },
    async rm(task) {
      const outcome = await run(argvFor(task));
      return { ...outcome, removed: outcome.code === 0 };
    },
    async tag(task) {
      const outcome = await must(argvFor(task), "tag");
      return { ...outcome, tagged: true };
    },
    async inspect(task) {
      const outcome = await run(argvFor(task));
      if (outcome.code !== 0) {
        return {
          ...outcome,
          exists: false,
          running: false,
          healthy: false,
          image: null,
          digest: null,
          port: null,
        };
      }
      let state = {};
      try {
        state = JSON.parse(outcome.stdout.trim());
      } catch {
        state = {};
      }
      const running = state.Running === true;
      const healthStatus = state.Health?.Status ?? null;
      return {
        ...outcome,
        exists: true,
        running,
        healthy:
          running && (healthStatus === null || healthStatus === "healthy"),
        healthStatus,
        image: null,
        digest: null,
        port: null,
      };
    },
    async logs(task) {
      const outcome = await must(argvFor(task), "logs");
      return {
        ...outcome,
        lines: outcome.stdout.split("\n").filter((line) => line !== ""),
      };
    },
    async ps(task) {
      const outcome = await run(argvFor(task));
      const containers = outcome.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line };
          }
        });
      return { ...outcome, containers };
    },
    probe: probeHttp,
  };
}

/**
 * Detect which container runtime binary exists on this host.
 * @param {{ exec?: (argv: string[]) => Promise<{ code: number }> }} [options]
 * @returns {Promise<string|null>} "docker", "podman" or null
 */
export async function detectRuntime(options = {}) {
  const exec = options.exec ?? execFileAsync;
  for (const candidate of RUNTIMES) {
    const outcome = await exec([candidate, "--version"]);
    if (outcome.code === 0) return candidate;
  }
  return null;
}

/**
 * Build the driver a command should use.
 * @param {{ driver?: string, simulate?: string, app: string, runtime?: string, world?: object, onCall?: (call: object) => void }} input
 * @returns {Promise<object>} driver plus a note explaining the choice
 */
export async function resolveDriver(input) {
  const requested = input.driver ?? "auto";
  if (requested === "dry-run") {
    const runtime = input.runtime ?? "docker";
    return {
      driver: createDryRunDriver({
        app: input.app,
        runtime,
        simulate: input.simulate ?? "healthy",
        world: input.world,
        onCall: input.onCall,
      }),
      note: "dry-run: argv is recorded and no runtime, image or network is touched",
    };
  }
  if (requested !== "auto" && requested !== "docker") {
    throw new Error(
      'unknown driver "' + requested + '"; use "docker" or "dry-run"',
    );
  }
  const detected = input.runtime ?? (await detectRuntime());
  if (!detected) {
    throw new Error(
      "no container runtime found: install docker or podman, or pass --driver dry-run to inspect the commands only",
    );
  }
  return {
    driver: createDockerDriver({ runtime: detected }),
    note: "runtime: " + detected,
  };
}
