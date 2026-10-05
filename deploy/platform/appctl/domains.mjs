/**
 * Domain-provider adapters for Layer 4 app hosting.
 *
 * WHY this fails closed: binding a hostname is an external side effect on the operator's own
 * account, so the adapter runs only when the manifest's secret reference actually resolves from
 * the environment. A missing reference is an error, never a silent skip and never a prompt -
 * appctl must not invent a credential or read one out of a file.
 *
 * WHAT never happens here: the token value is used to build one Authorization header for the
 * real API call and is then dropped. It is not returned, not written to the ledger or the
 * request log, and not copied into the recorded request, which carries the reference NAME.
 */

/** Raised when a provider's declared secret reference does not resolve. */
export class MissingSecretReferenceError extends Error {
  /**
   * @param {string} reference the environment variable name that is missing, never its value
   * @param {string} [detail]
   */
  constructor(reference, detail) {
    super(
      "missing secret reference: " +
        reference +
        (detail ? " (" + detail + ")" : "") +
        "; export it in the environment before binding a domain - appctl never reads a credential from a file",
    );
    this.name = "MissingSecretReferenceError";
    this.code = "missing-secret-reference";
    this.reference = reference;
    this.exitCode = 1;
  }
}

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * Resolve an environment reference, treating an empty string as absent.
 * @param {Record<string, string|undefined>} env
 * @param {string} reference
 * @returns {string|null}
 */
export function resolveEnvReference(env, reference) {
  const value = env[reference];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Build the redacted form of a request for the log and the command output.
 * @param {{ method: string, url: string, headers: Record<string,string>, body: object|null, secretRef: string|null }} request
 * @returns {object} request with the credential replaced by its reference name
 */
export function redactRequest(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] =
      name.toLowerCase() === "authorization"
        ? "<redacted " + (request.secretRef ?? "credential") + ">"
        : value;
  }
  return {
    method: request.method,
    url: request.url,
    headers,
    body: request.body,
  };
}

/**
 * Cloudflare for SaaS adapter: POST a custom hostname, and PUT it when it already exists.
 * @param {{ env: Record<string, string|undefined>, mode: "dry-run"|"live", fetchImpl?: typeof fetch, record?: (entry: object) => object }} input
 * @returns {{ id: string, mode: string, bind: (bind: object) => Promise<object> }} provider
 */
export function createCloudflareSaasProvider(input) {
  const env = input.env;
  const mode = input.mode;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const record = input.record ?? (() => null);
  return {
    id: "cloudflare-saas",
    mode,
    /**
     * Bind one hostname to the app's origin.
     * @param {{ hostname: string, refs: { tokenRef: string|null, zoneRef: string|null }, zone?: string|null }} bind
     * @returns {Promise<object>} provider result, with no credential in it
     */
    async bind(bind) {
      const tokenRef = bind.refs?.tokenRef ?? null;
      if (!tokenRef) {
        throw new MissingSecretReferenceError(
          "domains[].env",
          "the " + bind.hostname + " entry declares no token variable name",
        );
      }
      const token = resolveEnvReference(env, tokenRef);
      if (!token) throw new MissingSecretReferenceError(tokenRef);
      const zoneRef = bind.refs?.zoneRef ?? null;
      const zone =
        bind.zone ?? (zoneRef ? resolveEnvReference(env, zoneRef) : null);
      if (!zone) {
        throw new MissingSecretReferenceError(
          zoneRef ?? "domains[].zone",
          "the zone is a configuration reference, not a secret, and cloudflare-saas cannot address an API path without it",
        );
      }
      const collection =
        CLOUDFLARE_API +
        "/zones/" +
        encodeURIComponent(zone) +
        "/custom_hostnames";
      const body = {
        hostname: bind.hostname,
        ssl: { method: "http", type: "dv" },
      };
      const attempted = {
        method: "POST",
        url: collection,
        secretRef: tokenRef,
      };
      if (mode === "dry-run") {
        // Still gated on the reference resolving above: a dry run shows the request that WOULD
        // be sent, but it must not pretend a credential exists when none does.
        const request = redactRequest({
          ...attempted,
          headers: { authorization: "Bearer " + token },
          body,
        });
        record({
          provider: "cloudflare-saas",
          mode,
          hostname: bind.hostname,
          request,
          result: "recorded",
        });
        return {
          ok: true,
          recorded: true,
          provider: "cloudflare-saas",
          hostname: bind.hostname,
          zone,
          secretRef: tokenRef,
          status: "pending",
          request,
        };
      }
      const call = async (method, url) => {
        const headers = {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        };
        const response = await fetchImpl(url, {
          method,
          headers,
          body: JSON.stringify(body),
        });
        const text = await response.text();
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 400) };
        }
        const request = redactRequest({
          method,
          url,
          headers,
          body,
          secretRef: tokenRef,
        });
        record({
          provider: "cloudflare-saas",
          mode,
          hostname: bind.hostname,
          request,
          result: response.ok ? "ok" : "failed",
          status: response.status,
        });
        return { ok: response.ok, status: response.status, payload, request };
      };
      const created = await call("POST", collection);
      if (created.status !== 409) {
        return {
          ok: created.ok,
          recorded: false,
          provider: "cloudflare-saas",
          hostname: bind.hostname,
          zone,
          secretRef: tokenRef,
          status: created.ok ? "pending" : "failed",
          request: created.request,
          response: created.payload,
        };
      }
      // 409 means the hostname exists for this zone; update it in place rather than failing.
      const listed = await call(
        "GET",
        collection + "?hostname=" + encodeURIComponent(bind.hostname),
      );
      const existingId = listed.payload?.result?.[0]?.id ?? null;
      if (!existingId) {
        return {
          ok: false,
          recorded: false,
          provider: "cloudflare-saas",
          hostname: bind.hostname,
          zone,
          secretRef: tokenRef,
          status: "conflict-unresolved",
          request: created.request,
          response: listed.payload,
        };
      }
      const updated = await call(
        "PUT",
        collection + "/" + encodeURIComponent(existingId),
      );
      return {
        ok: updated.ok,
        recorded: false,
        provider: "cloudflare-saas",
        hostname: bind.hostname,
        zone,
        secretRef: tokenRef,
        status: updated.ok ? "pending" : "failed",
        request: updated.request,
        response: updated.payload,
      };
    },
  };
}

const PROVIDERS = { "cloudflare-saas": createCloudflareSaasProvider };

/**
 * Create the adapter a manifest domain entry names.
 * @param {string} id provider id from the manifest
 * @param {object} options passed through to the adapter
 * @returns {{ id: string, mode: string, bind: (bind: object) => Promise<object> }}
 */
export function createDomainProvider(id, options) {
  const factory = PROVIDERS[id];
  if (!factory) {
    throw new Error(
      'no domain provider adapter for "' +
        id +
        '"; known providers are ' +
        Object.keys(PROVIDERS).join(", "),
    );
  }
  return factory(options);
}

/**
 * List the provider adapters this build ships.
 * @returns {string[]}
 */
export function providerIds() {
  return Object.keys(PROVIDERS);
}
