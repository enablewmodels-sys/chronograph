/**
 * Lifecycle orchestration for Layer 4 app hosting: plan, build, deploy, promote, rollback,
 * status, logs, destroy and bind-domain.
 *
 * WHY the state file is the source of truth for promotion: a preview and the production
 * environment it promotes into must run the byte-identical image, so the digest the preview
 * actually ran is recorded at deploy time and promotion replays that digest instead of the
 * mutable tag. A missing digest is refused rather than rebuilt, because "promote" that quietly
 * builds something new is not a promotion.
 */

import { appendDomainRequest, appendLedger, allocatePort } from "./state.mjs";
import {
  buildTask,
  inspectTask,
  logsTask,
  psTask,
  rmTask,
  runTask,
  stopTask,
  tagTask,
  volumeCreateTask,
  volumeInspectTask,
  volumeRemoveTask,
  argvFor,
} from "./drivers.mjs";
import {
  MissingSecretReferenceError,
  createDomainProvider,
} from "./domains.mjs";
import { DEFAULT_MAX_VOLUME_GB, domainRefs, findDomain } from "./manifest.mjs";
import { waitForHealth } from "./health.mjs";

/** A hosting action that was refused or failed, carrying a stable code. */
export class HostingError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description
   * @param {object} [detail] extra machine-readable detail, for example the last health response
   */
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "HostingError";
    this.code = code;
    this.detail = detail;
    this.exitCode = 1;
  }
}

/**
 * The image repository every environment of an app shares.
 * @param {string} app app name
 * @returns {string} repository without a tag
 */
export function imageRepository(app) {
  return "appctl/" + app;
}

/**
 * The environment key a command targets; preview is literally `<app>-preview`.
 * @param {string} app app name
 * @param {{ preview?: boolean, env?: string }} [options]
 * @returns {string} environment key
 */
export function environmentKey(app, options = {}) {
  if (options.preview || options.env === "preview") return app + "-preview";
  return options.env ?? "production";
}

/**
 * The scope name that keeps container and volume names unique per app and environment.
 * @param {string} app app name
 * @param {string} envKey environment key
 * @returns {string} name segment
 */
export function scopeName(app, envKey) {
  return envKey === "production" ? app : envKey;
}

/**
 * @param {string} app app name
 * @param {string} envKey environment key
 * @returns {string} container name
 */
export function containerName(app, envKey) {
  return "appctl-" + scopeName(app, envKey);
}

/**
 * @param {string} app app name
 * @param {string} envKey environment key
 * @returns {string} named volume name
 */
export function volumeName(app, envKey) {
  return "appctl-" + scopeName(app, envKey) + "-data";
}

/**
 * Environment flags for `docker run`.
 * WHY a secret-ref becomes a bare NAME: docker reads the value from the operator's own
 * environment, so the credential never reaches an argv, a state file, a dry-run trace or a log.
 * @param {object} manifest normalized manifest
 * @returns {string[]} flags in `-e NAME[=value]` form
 */
export function envFlagsFor(manifest) {
  return manifest.env.map((variable) =>
    variable.kind === "secret-ref" || variable.value === null
      ? variable.name
      : variable.name + "=" + variable.value,
  );
}

/**
 * Refuse a deploy whose storage request or existing volume does not match the manifest.
 *
 * THE RULE: the manifest's `persistence.sizeGb` is a ceiling, not a suggestion. appctl refuses
 * a deploy that asks for more than the manifest declares, and refuses a volume on disk whose
 * recorded size differs from the manifest - a volume cannot be resized in place, so silently
 * reusing a smaller or larger one would either corrupt a database or hand out storage the
 * manifest never approved.
 * @param {{ manifest: object, requested?: number, previous?: object|null, maxVolumeGb?: number }} input
 * @returns {void}
 */
export function assertVolumeSize(input) {
  const declared = input.manifest.persistence?.sizeGb ?? null;
  const maxVolumeGb = input.maxVolumeGb ?? DEFAULT_MAX_VOLUME_GB;
  if (input.requested !== undefined) {
    if (!Number.isInteger(input.requested) || input.requested < 1) {
      throw new HostingError(
        "invalid-volume-size",
        "--size-gb must be an integer >= 1",
      );
    }
    if (declared !== null && input.requested > declared) {
      throw new HostingError(
        "requested-over-declared",
        "requested volume size " +
          input.requested +
          "GB exceeds the " +
          declared +
          "GB this manifest declares; raise persistence.sizeGb deliberately instead of growing storage behind the manifest's back",
      );
    }
    if (declared === null && input.requested > maxVolumeGb) {
      throw new HostingError(
        "volume-too-large",
        "requested volume size exceeds the " + maxVolumeGb + "GB ceiling",
      );
    }
  }
  if (
    input.previous &&
    declared !== null &&
    input.previous.sizeGb !== declared
  ) {
    throw new HostingError(
      "volume-size-mismatch",
      "volume " +
        input.previous.name +
        " is recorded as " +
        input.previous.sizeGb +
        "GB but the manifest declares " +
        declared +
        "GB; a volume is not resizable in place, so destroy it explicitly with destroy --purge-volume when that data may be discarded",
    );
  }
}

/**
 * Refuse a replica count this runtime cannot honour.
 * WHY refuse instead of deploying one container: a manifest that declares replicas: 3 is asking
 * for redundancy this single-host lifecycle does not provide, and quietly running one container
 * would turn an availability requirement into a silent downgrade.
 * @param {object} manifest normalized manifest
 * @returns {void}
 */
export function assertReplicasSupported(manifest) {
  if (manifest.run.replicas !== 1) {
    throw new HostingError(
      "unsupported-replicas",
      "run.replicas is " +
        manifest.run.replicas +
        " but appctl runs one container per environment on one host; scaling out needs an orchestrator that this layer does not claim",
    );
  }
}

function resolveHostPort({ stateRoot, state, envKey, manifest, requested }) {
  if (requested !== undefined) return requested;
  const existing = state.envs[envKey];
  if (existing && typeof existing.port === "number") return existing.port;
  const reserved = Object.values(state.envs)
    .map((record) => record.port)
    .filter((port) => typeof port === "number");
  // WHY +1 for a preview: the preview must be reachable next to production, so it takes the
  // first free port above the app's own port instead of colliding with the live one.
  const preferred =
    envKey === "production" ? manifest.run.port : manifest.run.port + 1;
  return allocatePort({ root: stateRoot, preferred, reserved });
}

function labelsFor({ app, envKey, digest, promotedFrom }) {
  const labels = {
    "chronograph.app": app,
    "chronograph.env": envKey,
    "chronograph.digest": digest,
  };
  if (promotedFrom) labels["chronograph.promoted-from"] = promotedFrom;
  return labels;
}

function ledgerEntry({ context, app, envKey, action, result, extra = {} }) {
  return {
    app,
    env: envKey,
    action,
    result,
    // WHY only a reference name: the ledger is read by operators and archived by tooling, so a
    // credential value in it would be a permanent leak.
    actor: context.actor,
    at: context.now().toISOString(),
    ...extra,
  };
}

/**
 * Build the image for one environment and record its digest.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, context: object, tag: string }} input
 * @returns {Promise<{ digest: string, tag: string, argv: string[] }>}
 */
export async function buildImage(input) {
  const { manifest, driver, state, context } = input;
  const tag =
    input.tag ??
    imageRepository(manifest.name) + ":" + environmentKey(manifest.name);
  const built = await driver.build(
    buildTask({
      runtime: driver.runtime,
      app: manifest.name,
      tag,
      context: manifest.build.context,
      dockerfile: manifest.build.dockerfile,
      buildIndex: state.builds.length + 1,
      manifestHash: manifest.manifestHash,
    }),
  );
  if (!built.digest || built.digest === "unknown") {
    throw new HostingError(
      "missing-digest",
      "the runtime did not report an image digest for " + tag,
    );
  }
  state.builds.push({
    tag,
    digest: built.digest,
    at: context.now().toISOString(),
  });
  return { digest: built.digest, tag, argv: built.argv };
}

function latestBuild(state) {
  return state.builds.length > 0 ? state.builds[state.builds.length - 1] : null;
}

function imageReference(repo, digest) {
  return repo + "@" + digest;
}

/**
 * Describe what a deploy would do without touching the runtime.
 * @param {{ manifest: object, driver: object, state: object, options: object }} input
 * @returns {object} plan
 */
export function planDeployment(input) {
  const { manifest, driver, state, options } = input;
  const app = manifest.name;
  const envKey = environmentKey(app, options);
  const scope = scopeName(app, envKey);
  const container = containerName(app, envKey);
  const volume = volumeName(app, envKey);
  const repo = imageRepository(app);
  const runtime = driver.runtime;
  const hostPort = resolveHostPort({
    stateRoot: options.stateRoot,
    state,
    envKey,
    manifest,
    requested: options.hostPort,
  });
  const tag = repo + ":" + envKey;
  const digest = options.image ?? latestBuild(state)?.digest ?? null;
  const steps = [];
  if (manifest.persistence) {
    steps.push({
      action: "volume-create",
      argv: argvFor(
        volumeCreateTask({
          runtime,
          app,
          env: envKey,
          name: volume,
          sizeGb: manifest.persistence.sizeGb,
        }),
      ),
      note:
        "named volume of the declared size, mounted at " +
        manifest.persistence.mount,
    });
  }
  steps.push({
    action: "build",
    argv: argvFor(
      buildTask({
        runtime,
        app,
        tag,
        context: manifest.build.context,
        dockerfile: manifest.build.dockerfile,
        buildIndex: state.builds.length + 1,
        manifestHash: manifest.manifestHash,
      }),
    ),
    note:
      options.build === false
        ? "skipped: --no-build"
        : "one image per app, tagged " + tag,
  });
  if (state.envs[envKey]) {
    steps.push({
      action: "stop",
      argv: argvFor(stopTask({ runtime, name: container })),
      note: "replace the running container in place",
    });
    steps.push({
      action: "rm",
      argv: argvFor(rmTask({ runtime, name: container })),
    });
  }
  steps.push({
    action: "run",
    argv: argvFor(
      runTask({
        runtime,
        name: container,
        image: digest ? imageReference(repo, digest) : tag,
        envFlags: envFlagsFor(manifest),
        volume: manifest.persistence ? volume : null,
        mount: manifest.persistence ? manifest.persistence.mount : null,
        port: manifest.run.port,
        hostPort,
        labels: labelsFor({ app, envKey, digest: digest ?? tag }),
      }),
    ),
    note:
      "published on 127.0.0.1:" +
      hostPort +
      " only; the public path is the domain provider or the local proxy",
  });
  steps.push({
    action: "health",
    url: "http://127.0.0.1:" + hostPort + manifest.run.health,
    timeoutMs: options.healthTimeoutMs,
    note: "poll until 2xx; on failure the container is stopped and removed again",
  });
  for (const entry of manifest.domains) {
    steps.push({
      action: "bind-domain",
      hostname: entry.hostname,
      provider: entry.provider,
      refs: domainRefs(entry),
      note: "manual step: run appctl bind-domain --hostname " + entry.hostname,
    });
  }
  for (const store of manifest.stores) {
    steps.push({
      action: "publish-store",
      store: store.store,
      artifact: store.artifact,
      requires: store.requires,
      note: "manual step: store submission needs the operator's own account and signing keys",
    });
  }
  return {
    app,
    env: envKey,
    scope,
    container,
    volume: manifest.persistence ? volume : null,
    volumeSizeGb: manifest.persistence?.sizeGb ?? null,
    mount: manifest.persistence?.mount ?? null,
    port: manifest.run.port,
    hostPort,
    replicas: manifest.run.replicas,
    health: manifest.run.health,
    image: { repo, tag, digest },
    envNames: manifest.env.map((variable) => ({
      name: variable.name,
      kind: variable.kind,
    })),
    domains: manifest.domains,
    stores: manifest.stores,
    steps,
    dryRun: options.preview
      ? "preview environment " + envKey
      : "environment " + envKey,
  };
}

function callOf(kind, argv) {
  return { kind, argv };
}

async function stopAndRemove(driver, name) {
  const stopped = await driver.stop(
    stopTask({ runtime: driver.runtime, name }),
  );
  const removed = await driver.rm(rmTask({ runtime: driver.runtime, name }));
  return [callOf("stop", stopped.argv), callOf("rm", removed.argv)];
}

function inspectLive(driver, name) {
  return driver.inspect(inspectTask({ runtime: driver.runtime, name }));
}

/**
 * Create or update one environment: volume, image, container, then prove it healthy.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} deploy result
 */
export async function deployEnvironment(input) {
  const { manifest, driver, stateRoot, state, options, context } = input;
  const app = manifest.name;
  const envKey = environmentKey(app, options);
  const container = containerName(app, envKey);
  const volume = volumeName(app, envKey);
  const repo = imageRepository(app);
  const at = context.now().toISOString();
  const argvLog = [];
  assertReplicasSupported(manifest);
  const declaredSize = manifest.persistence?.sizeGb ?? null;
  assertVolumeSize({
    manifest,
    requested: options.sizeGb,
    previous: state.volumes[volume] ?? null,
    maxVolumeGb: context.maxVolumeGb,
  });

  if (manifest.persistence) {
    const ensured = await driver.ensureVolume(
      volumeCreateTask({
        runtime: driver.runtime,
        app,
        env: envKey,
        name: volume,
        sizeGb: declaredSize,
      }),
    );
    argvLog.push(callOf("volume-create", ensured.argv));
    const observed = await driver.inspectVolume(
      volumeInspectTask({ runtime: driver.runtime, name: volume }),
    );
    argvLog.push(callOf("volume-inspect", observed.argv));
    // WHY after creation as well as from state: a volume made by an older appctl or by hand
    // carries its own label, and the label is the only size record docker keeps.
    if (
      observed.exists &&
      observed.sizeGb !== null &&
      observed.sizeGb !== declaredSize
    ) {
      throw new HostingError(
        "volume-size-mismatch",
        "volume " +
          volume +
          " on disk is " +
          observed.sizeGb +
          "GB but the manifest declares " +
          declaredSize +
          "GB; destroy it explicitly with destroy --purge-volume instead of resizing behind the manifest's back",
      );
    }
    state.volumes[volume] = {
      name: volume,
      sizeGb: declaredSize,
      app,
      env: envKey,
      at,
    };
  }

  let digest = null;
  if (options.image) {
    digest = options.image;
  } else if (options.build === false) {
    const recorded = latestBuild(state);
    if (!recorded) {
      throw new HostingError(
        "no-image",
        "no build is recorded for " +
          app +
          ", so --no-build has nothing to deploy; run appctl build first",
      );
    }
    digest = recorded.digest;
  } else {
    const built = await buildImage({
      manifest,
      driver,
      state,
      context,
      tag: repo + ":" + envKey,
    });
    digest = built.digest;
    argvLog.push(callOf("build", built.argv));
  }

  const previousRecord = state.envs[envKey];
  if (previousRecord?.container)
    argvLog.push(...(await stopAndRemove(driver, previousRecord.container)));

  const hostPort = resolveHostPort({
    stateRoot,
    state,
    envKey,
    manifest,
    requested: options.hostPort,
  });
  const started = await driver.run(
    runTask({
      runtime: driver.runtime,
      name: container,
      image: imageReference(repo, digest),
      envFlags: envFlagsFor(manifest),
      volume: manifest.persistence ? volume : null,
      mount: manifest.persistence ? manifest.persistence.mount : null,
      port: manifest.run.port,
      hostPort,
      labels: labelsFor({ app, envKey, digest }),
    }),
  );
  argvLog.push(callOf("run", started.argv));

  const health = await waitForHealth({
    driver,
    port: hostPort,
    path: manifest.run.health,
    timeoutMs: context.healthTimeoutMs,
    intervalMs: context.healthIntervalMs,
  });
  argvLog.push({
    kind: "health",
    probe: health.url,
    attempts: health.attempts,
  });

  const base = {
    env: envKey,
    container,
    image: imageReference(repo, digest),
    digest,
    port: hostPort,
    containerPort: manifest.run.port,
    volume: manifest.persistence ? volume : null,
    sizeGb: declaredSize,
    hostHealth: manifest.run.health,
    at,
  };

  if (!health.healthy) {
    argvLog.push(...(await stopAndRemove(driver, container)));
    state.envs[envKey] = {
      ...base,
      digest: null,
      unhealthyDigest: digest,
      running: false,
      health: "unhealthy",
      updatedAt: context.now().toISOString(),
    };
    appendLedger(
      stateRoot,
      app,
      ledgerEntry({
        context,
        app,
        envKey,
        action: "deploy",
        result: "unhealthy",
        extra: {
          digest,
          port: hostPort,
          attempts: health.attempts,
          lastStatus: health.lastResponse.status,
        },
      }),
    );
    throw new HostingError(
      "unhealthy",
      "environment " +
        envKey +
        " did not answer " +
        health.url +
        " with 2xx after " +
        health.attempts +
        " attempts; the container was stopped and removed",
      {
        lastResponse: health.lastResponse,
        url: health.url,
        attempts: health.attempts,
        calls: argvLog,
      },
    );
  }

  const history = [...(previousRecord?.history ?? [])];
  if (previousRecord?.digest && previousRecord.digest !== digest) {
    history.push({
      digest: previousRecord.digest,
      at: previousRecord.updatedAt ?? previousRecord.at ?? at,
      action: previousRecord.action ?? "deploy",
    });
  }
  state.envs[envKey] = {
    ...base,
    running: true,
    health: "healthy",
    action: "deploy",
    history,
    updatedAt: context.now().toISOString(),
  };
  appendLedger(
    stateRoot,
    app,
    ledgerEntry({
      context,
      app,
      envKey,
      action: "deploy",
      result: "ok",
      extra: {
        digest,
        image: imageReference(repo, digest),
        port: hostPort,
        preview: envKey !== "production",
        attempts: health.attempts,
      },
    }),
  );
  return {
    app,
    env: envKey,
    container,
    hostPort,
    digest,
    image: imageReference(repo, digest),
    health: health.lastResponse,
    attempts: health.attempts,
    calls: argvLog,
  };
}

async function startEnvironment(input) {
  const {
    manifest,
    driver,
    stateRoot,
    state,
    context,
    envKey,
    digest,
    hostPort,
    promotedFrom,
  } = input;
  const app = manifest.name;
  const container = containerName(app, envKey);
  const volume = volumeName(app, envKey);
  const repo = imageRepository(app);
  const argvLog = [];
  assertReplicasSupported(manifest);
  const previousRecord = state.envs[envKey];
  if (previousRecord?.container)
    argvLog.push(...(await stopAndRemove(driver, previousRecord.container)));
  const started = await driver.run(
    runTask({
      runtime: driver.runtime,
      name: container,
      image: imageReference(repo, digest),
      envFlags: envFlagsFor(manifest),
      volume: manifest.persistence ? volume : null,
      mount: manifest.persistence ? manifest.persistence.mount : null,
      port: manifest.run.port,
      hostPort,
      labels: labelsFor({ app, envKey, digest, promotedFrom }),
    }),
  );
  argvLog.push(callOf("run", started.argv));
  const health = await waitForHealth({
    driver,
    port: hostPort,
    path: manifest.run.health,
    timeoutMs: context.healthTimeoutMs,
    intervalMs: context.healthIntervalMs,
  });
  argvLog.push({
    kind: "health",
    probe: health.url,
    attempts: health.attempts,
  });
  if (!health.healthy) {
    argvLog.push(...(await stopAndRemove(driver, container)));
    state.envs[envKey] = {
      ...(previousRecord ?? {}),
      env: envKey,
      container,
      running: false,
      health: "unhealthy",
      updatedAt: context.now().toISOString(),
    };
    throw new HostingError(
      "unhealthy",
      "environment " +
        envKey +
        " did not answer " +
        health.url +
        " with 2xx after " +
        health.attempts +
        " attempts; the container was stopped and removed",
      {
        lastResponse: health.lastResponse,
        url: health.url,
        attempts: health.attempts,
        calls: argvLog,
      },
    );
  }
  return { container, argvLog, health, repo };
}

/**
 * Promote the exact digest a source environment ran into a target environment.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} promotion result
 */
export async function promoteEnvironment(input) {
  const { manifest, driver, stateRoot, state, options, context } = input;
  const app = manifest.name;
  // "preview" is accepted verbatim so the documented command works: the environment a preview
  // deploy creates is literally <app>-preview, and both spellings must resolve to it.
  const from =
    !options.from || options.from === "preview"
      ? app + "-preview"
      : options.from;
  const to = options.to ?? "production";
  const source = state.envs[from];
  if (!source) {
    throw new HostingError(
      "unknown-environment",
      "no environment named " +
        from +
        " is recorded for " +
        app +
        "; deploy it with deploy --preview first",
    );
  }
  if (source.health !== "healthy") {
    throw new HostingError(
      "preview-unhealthy",
      "refusing to promote: environment " +
        from +
        " is recorded as " +
        source.health +
        ", and only a healthy preview may be promoted",
    );
  }
  if (!source.digest) {
    throw new HostingError(
      "missing-digest",
      "refusing to promote: no image digest is recorded for " +
        from +
        "; a promotion must replay the exact digest the preview ran",
    );
  }
  // WHY a live re-check: the recorded health is from deploy time, and promoting an app that has
  // been failing for the last hour is exactly the mistake this pipeline exists to prevent.
  const live = await inspectLive(driver, source.container);
  if (!live.exists) {
    throw new HostingError(
      "preview-not-running",
      "refusing to promote: container " +
        source.container +
        " for " +
        from +
        " does not exist",
    );
  }
  if (!live.healthy) {
    throw new HostingError(
      "preview-unhealthy",
      "refusing to promote: container " +
        source.container +
        " for " +
        from +
        " is " +
        (live.running ? "running but not healthy" : "not running"),
      {
        inspect: {
          exists: live.exists,
          running: live.running,
          healthy: live.healthy,
        },
      },
    );
  }
  if (to === from) {
    throw new HostingError(
      "usage",
      "promote needs a target different from the source",
    );
  }
  const repo = imageRepository(app);
  const digest = source.digest;
  const argvLog = [];
  const tagged = await driver.tag(
    tagTask({
      runtime: driver.runtime,
      source: imageReference(repo, digest),
      target: repo + ":" + to,
    }),
  );
  argvLog.push(callOf("tag", tagged.argv));

  const envKey = to;
  const previousRecord = state.envs[envKey];
  const hostPort = resolveHostPort({
    stateRoot,
    state,
    envKey,
    manifest,
    requested: undefined,
  });
  // A promotion must land on the storage production already owns; a mismatched volume is a
  // data-loss action, so it is refused rather than recreated.
  assertVolumeSize({
    manifest,
    previous: state.volumes[volumeName(app, envKey)] ?? null,
    maxVolumeGb: context.maxVolumeGb,
  });
  const started = await startEnvironment({
    manifest,
    driver,
    stateRoot,
    state,
    context,
    envKey,
    digest,
    hostPort,
    promotedFrom: from,
  });
  argvLog.push(...started.argvLog);
  const history = [...(previousRecord?.history ?? [])];
  if (previousRecord?.digest && previousRecord.digest !== digest) {
    history.push({
      digest: previousRecord.digest,
      at:
        previousRecord.updatedAt ??
        previousRecord.at ??
        context.now().toISOString(),
      action: previousRecord.action ?? "deploy",
    });
  }
  const now = context.now().toISOString();
  state.envs[envKey] = {
    env: envKey,
    container: started.container,
    image: imageReference(repo, digest),
    digest,
    port: hostPort,
    containerPort: manifest.run.port,
    volume: manifest.persistence ? volumeName(app, envKey) : null,
    sizeGb: manifest.persistence?.sizeGb ?? null,
    hostHealth: manifest.run.health,
    running: true,
    health: "healthy",
    action: "promote",
    promotedFrom: from,
    history,
    at: previousRecord?.at ?? now,
    updatedAt: now,
  };
  appendLedger(
    stateRoot,
    app,
    ledgerEntry({
      context,
      app,
      envKey,
      action: "promote",
      result: "ok",
      extra: {
        digest,
        image: imageReference(repo, digest),
        from,
        port: hostPort,
      },
    }),
  );
  return {
    app,
    from,
    to: envKey,
    container: started.container,
    digest,
    image: imageReference(repo, digest),
    hostPort,
    calls: argvLog,
  };
}

/**
 * Run a previously recorded digest again in one environment.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} rollback result
 */
export async function rollbackEnvironment(input) {
  const { manifest, driver, stateRoot, state, options, context } = input;
  const app = manifest.name;
  const envKey = options.env ?? "production";
  const record = state.envs[envKey];
  if (!record) {
    throw new HostingError(
      "unknown-environment",
      "no environment named " + envKey + " is recorded for " + app,
    );
  }
  const history = record.history ?? [];
  let target = null;
  if (options.to) {
    target = history.find((entry) => entry.digest === options.to) ?? null;
    if (!target) {
      throw new HostingError(
        "unknown-digest",
        "digest " + options.to + " is not in the recorded history of " + envKey,
      );
    }
  } else {
    target =
      [...history].reverse().find((entry) => entry.digest !== record.digest) ??
      null;
  }
  if (!target) {
    throw new HostingError(
      "no-previous-image",
      "no earlier image digest is recorded for " +
        envKey +
        "; appctl will not invent a rollback target",
    );
  }
  const volume = volumeName(app, envKey);
  assertVolumeSize({
    manifest,
    previous: state.volumes[volume] ?? null,
    maxVolumeGb: context.maxVolumeGb,
  });
  const hostPort = resolveHostPort({
    stateRoot,
    state,
    envKey,
    manifest,
    requested: undefined,
  });
  const started = await startEnvironment({
    manifest,
    driver,
    stateRoot,
    state,
    context,
    envKey,
    digest: target.digest,
    hostPort,
  });
  const now = context.now().toISOString();
  const repo = imageRepository(app);
  state.envs[envKey] = {
    ...record,
    digest: target.digest,
    image: imageReference(repo, target.digest),
    container: started.container,
    running: true,
    health: "healthy",
    action: "rollback",
    history,
    updatedAt: now,
  };
  appendLedger(
    stateRoot,
    app,
    ledgerEntry({
      context,
      app,
      envKey,
      action: "rollback",
      result: "ok",
      extra: {
        digest: target.digest,
        image: imageReference(repo, target.digest),
        restoredFrom: target.at,
      },
    }),
  );
  return {
    app,
    env: envKey,
    digest: target.digest,
    image: imageReference(repo, target.digest),
    hostPort,
    calls: started.argvLog,
  };
}

/**
 * Report recorded environments next to what the runtime actually says.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} status
 */
export async function statusApp(input) {
  const { manifest, driver, stateRoot, state } = input;
  const envs = [];
  for (const [envKey, record] of Object.entries(state.envs)) {
    const live = await inspectLive(driver, record.container);
    envs.push({
      env: envKey,
      container: record.container,
      exists: live.exists,
      running: live.exists ? live.running : false,
      healthy: live.exists ? live.healthy : false,
      recordedHealth: record.health ?? null,
      port: record.port ?? null,
      digest: record.digest ?? null,
      image: record.image ?? null,
      volume: record.volume ?? null,
      sizeGb: record.sizeGb ?? null,
      action: record.action ?? null,
      updatedAt: record.updatedAt ?? null,
    });
  }
  const ps = await driver.ps(psTask({ runtime: driver.runtime }));
  return {
    app: manifest.name,
    driver: driver.id,
    runtime: driver.runtime,
    envs,
    volumes: Object.values(state.volumes),
    containers: ps.containers,
    domains: state.domains ?? {},
    builds: state.builds,
  };
}

/**
 * Read logs from one environment's container.
 * @param {{ manifest: object, driver: object, state: object, options: object }} input
 * @returns {Promise<object>} logs
 */
export async function logsApp(input) {
  const { manifest, driver, state, options } = input;
  const envKey = options.env ?? "production";
  const record = state.envs[envKey];
  if (!record) {
    throw new HostingError(
      "unknown-environment",
      "no environment named " + envKey + " is recorded for " + manifest.name,
    );
  }
  const tail = options.tail ?? 100;
  const outcome = await driver.logs(
    logsTask({ runtime: driver.runtime, name: record.container, tail }),
  );
  return {
    app: manifest.name,
    env: envKey,
    container: record.container,
    tail,
    lines: outcome.lines,
    argv: outcome.argv,
  };
}

/**
 * Stop and remove containers, deleting a data volume only when explicitly asked.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} destroy result
 */
export async function destroyEnvironment(input) {
  const { manifest, driver, stateRoot, state, options, context } = input;
  const app = manifest.name;
  const targets = options.all
    ? Object.keys(state.envs)
    : [options.env ?? "production"];
  if (targets.length === 0) {
    throw new HostingError(
      "unknown-environment",
      "no environment is recorded for " + app,
    );
  }
  const destroyed = [];
  for (const envKey of targets) {
    const record = state.envs[envKey];
    if (!record) {
      throw new HostingError(
        "unknown-environment",
        "no environment named " + envKey + " is recorded for " + app,
      );
    }
    const argvLog = await stopAndRemove(driver, record.container);
    let volumePurged = false;
    // WHY the volume survives by default: it holds a database, and deleting it is the one
    // action in this runtime that cannot be undone, so it needs --purge-volume.
    if (options.purgeVolume && record.volume) {
      const removed = await driver.removeVolume(
        volumeRemoveTask({ runtime: driver.runtime, name: record.volume }),
      );
      argvLog.push(callOf("volume-remove", removed.argv));
      delete state.volumes[record.volume];
      volumePurged = true;
    }
    const now = context.now().toISOString();
    state.envs[envKey] = {
      ...record,
      running: false,
      health: "destroyed",
      destroyedAt: now,
      updatedAt: now,
      volumeRetained: !volumePurged && Boolean(record.volume),
    };
    appendLedger(
      stateRoot,
      app,
      ledgerEntry({
        context,
        app,
        envKey,
        action: "destroy",
        result: "ok",
        extra: {
          container: record.container,
          volumePurged,
          volume: record.volume ?? null,
        },
      }),
    );
    destroyed.push({
      env: envKey,
      container: record.container,
      volume: record.volume ?? null,
      volumePurged,
      calls: argvLog,
    });
  }
  return { app, destroyed };
}

/**
 * Bind a manifest-declared hostname through its provider adapter.
 * @param {{ manifest: object, driver: object, stateRoot: string, state: object, options: object, context: object }} input
 * @returns {Promise<object>} bind result
 */
export async function bindDomain(input) {
  const { manifest, driver, stateRoot, state, options, context } = input;
  const app = manifest.name;
  const hostname = options.hostname;
  if (!hostname)
    throw new HostingError("usage", "bind-domain needs --hostname <hostname>");
  const entry = findDomain(manifest, hostname);
  if (!entry) {
    throw new HostingError(
      "undeclared-hostname",
      "hostname " +
        hostname +
        " is not declared in " +
        manifest.manifestPath +
        "; declared hostnames: " +
        (manifest.domains.map((domain) => domain.hostname).join(", ") ||
          "(none)"),
    );
  }
  const refs = domainRefs(entry);
  const envKey = options.env ?? "production";
  const record = state.envs[envKey];
  const provider = createDomainProvider(entry.provider, {
    env: context.env,
    mode: driver.id === "dry-run" ? "dry-run" : "live",
    record: (event) =>
      appendDomainRequest(stateRoot, app, { ...event, env: envKey }),
  });
  let result;
  try {
    result = await provider.bind({ hostname, refs, zone: options.zone });
  } catch (error) {
    if (error instanceof MissingSecretReferenceError) {
      appendLedger(
        stateRoot,
        app,
        ledgerEntry({
          context,
          app,
          envKey,
          action: "bind-domain",
          result: "refused",
          extra: {
            hostname,
            provider: entry.provider,
            secretRef: error.reference,
            reason: error.code,
          },
        }),
      );
    }
    throw error;
  }
  const now = context.now().toISOString();
  state.domains = state.domains ?? {};
  state.domains[hostname] = {
    hostname,
    provider: entry.provider,
    env: envKey,
    port: record?.port ?? null,
    secretRef: refs.tokenRef,
    status: result.status,
    recorded: Boolean(result.recorded),
    at: now,
  };
  appendLedger(
    stateRoot,
    app,
    ledgerEntry({
      context,
      app,
      envKey,
      action: "bind-domain",
      result: "ok",
      extra: {
        hostname,
        provider: entry.provider,
        secretRef: refs.tokenRef,
        recorded: Boolean(result.recorded),
        status: result.status,
      },
    }),
  );
  return { app, env: envKey, hostname, provider: entry.provider, refs, result };
}
