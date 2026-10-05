// Billing maps a provider's subscription state to project capacity.
//
// No card data reaches this repository, and no capacity decision is made from a
// client-supplied value: only a signed provider event or an authenticated read of the
// provider's own subscription object changes capacity.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Capacity granted to a project that has no paid subscription. */
export const FREE_TIER = Object.freeze({ seats: 1, storageGb: 5, retentionDays: 30 });
/** Capacity per paid seat. */
export const PER_SEAT = Object.freeze({ seats: 1, storageGb: 100, retentionDays: 365 });
/** Signature tolerance, in seconds, for a webhook delivery. */
export const TOLERANCE_SECONDS = 300;

/** Subscription states and the capacity they grant. */
const STATEFUL = {
  active: "paid",
  trialing: "paid",
  past_due: "free",
  unpaid: "free",
  incomplete: "free",
  incomplete_expired: "none",
  canceled: "none",
  paused: "free",
};

/**
 * Capacity for one subscription.
 *
 * @param {{status?: string, quantity?: number}} subscription provider object
 */
export function capacityFor(subscription = {}) {
  const state = STATEFUL[subscription.status];
  if (state === undefined)
    throw new TypeError("Unknown subscription status: " + String(subscription.status));
  if (state === "none") return { ...FREE_TIER, seats: 0, plan: "canceled" };
  if (state === "free") return { ...FREE_TIER, plan: "free" };
  const seats = Number.isInteger(subscription.quantity) && subscription.quantity > 0 ? subscription.quantity : 1;
  return {
    seats: PER_SEAT.seats * seats,
    storageGb: PER_SEAT.storageGb * seats,
    retentionDays: PER_SEAT.retentionDays,
    plan: "paid",
  };
}

/**
 * Verify a Stripe-style webhook signature.
 *
 * The signature covers the timestamp together with the raw body, so the body must
 * be the bytes that arrived: parsing and re-serializing it would invalidate the
 * check. A replayed delivery inside the tolerance window is refused by the caller's
 * seen-set, which this function reports rather than hides.
 *
 * @param {object} options
 * @param {Buffer|string} options.body raw request body
 * @param {string} options.header value of the signature header
 * @param {string} options.secret the webhook signing secret
 * @param {() => number} options.now clock in milliseconds
 */
export function verifyWebhook({ body, header, secret, now }) {
  if (typeof header !== "string" || header === "")
    throw new Error("Unsigned webhook: a signature header is required.");
  const parts = new Map(
    header
      .split(",")
      .map((piece) => piece.split("="))
      .filter((pair) => pair.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()]),
  );
  const timestamp = Number(parts.get("t"));
  const provided = parts.get("v1");
  if (!Number.isFinite(timestamp) || !provided)
    throw new Error("Malformed signature header.");
  const age = Math.abs(Math.floor(now() / 1000) - timestamp);
  if (age > TOLERANCE_SECONDS) throw new Error("Signature outside the tolerance window.");
  const expected = createHmac("sha256", secret)
    .update(String(timestamp) + "." + body)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b))
    throw new Error("Signature does not match.");
  return { timestamp, digest: expected, replayKey: timestamp + ":" + provided };
}

/**
 * Build the billing connector.
 *
 * @param {object} options
 * @param {{require: (name: string) => string, has: (name: string) => boolean}} options.secrets
 * @param {() => number} options.now clock in milliseconds
 * @param {{apiKey: string, webhookSecret: string}} [options.references] reference names
 */
export function createBilling({
  secrets,
  now,
  references = { apiKey: "CHRONOGRAPH_BILLING_API_KEY", webhookSecret: "CHRONOGRAPH_BILLING_WEBHOOK_SECRET" },
}) {
  const seen = new Set();
  return {
    capacityFor,
    /** Capacity for a project, read from the provider only when a key is configured. */
    async capacity({ fetch: fetcher, subscriptionId }) {
      const key = secrets.require(references.apiKey);
      const response = await fetcher("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subscriptionId), {
        headers: { authorization: "Bearer " + key },
      });
      if (!response.ok) throw new Error("Subscription read failed: " + response.status);
      return capacityFor(await response.json());
    },
    /**
     * Handle one delivery. The raw body is required, and a duplicate signature inside
     * the tolerance window is refused rather than applied twice.
     */
    acceptWebhook({ body, header }) {
      const secret = secrets.require(references.webhookSecret);
      const verified = verifyWebhook({ body, header, secret, now });
      if (seen.has(verified.replayKey)) throw new Error("Replayed webhook delivery.");
      seen.add(verified.replayKey);
      if (seen.size > 1024) seen.delete(seen.values().next().value);
      return JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
    },
    references,
  };
}
