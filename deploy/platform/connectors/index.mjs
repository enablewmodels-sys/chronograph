// One factory for every delegated concern, so a caller injects transport, clock and
// mode once and the connectors stay free of module-level state and network-on-import.
import { createSecrets } from "./secrets.mjs";
import { createVerifier } from "./identity.mjs";
import { createBilling } from "./billing.mjs";
import { createDomains } from "./domains.mjs";

export { createSecrets, MissingSecretError } from "./secrets.mjs";
export { createVerifier, TokenRejected, safeEqual } from "./identity.mjs";
export { createBilling, capacityFor, verifyWebhook, FREE_TIER } from "./billing.mjs";
export { createDomains, API as DOMAINS_API } from "./domains.mjs";

/**
 * Build every connector from one configuration.
 *
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env] values for secret references
 * @param {(url: string, init?: object) => Promise<Response>} [options.fetch] transport
 * @param {() => number} [options.now] clock in milliseconds
 * @param {"live"|"record"} [options.mode] record mode sends nothing and returns the plan
 * @param {{issuer: string, audience: string, ttlMs?: number, clockSkewSeconds?: number}} [options.identity]
 */
export function createConnectors({
  env = {},
  fetch: fetcher,
  now = () => Date.now(),
  mode = "live",
  identity,
} = {}) {
  if (mode !== "live" && mode !== "record") throw new TypeError("Unknown connector mode: " + mode);
  const transport = fetcher ?? globalThis.fetch;
  if (mode === "live" && typeof transport !== "function")
    throw new TypeError("A fetch implementation is required in live mode.");
  const secrets = createSecrets(env);
  return {
    mode,
    secrets,
    identity: identity ? createVerifier({ fetch: transport, now, ...identity }) : null,
    billing: createBilling({ secrets, now }),
    domains: createDomains({ secrets, fetch: transport, record: mode === "record" }),
  };
}
