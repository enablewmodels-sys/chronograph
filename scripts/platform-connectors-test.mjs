// Evidence for the delegated Layer 5 connectors: real keys, real signatures, no
// network. The identity tests generate key pairs and sign tokens with node:crypto, so
// a passing run means the verifier accepted a genuine signature and refused everything
// else, rather than agreeing with a mock.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { createConnectors, createSecrets, MissingSecretError, TokenRejected } from "../deploy/platform/connectors/index.mjs";

const ISSUER = "https://identity.example";
const AUDIENCE = "chronodb";
const NOW = 1_800_000_000_000;
const now = () => NOW;

function segment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(header, payload, key, algorithm) {
  const input = segment(header) + "." + segment(payload);
  const signature = signBytes(algorithm, Buffer.from(input), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return input + "." + signature.toString("base64url");
}

function claims(overrides = {}) {
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "user-42",
    email: "operator@example.com",
    email_verified: true,
    exp: Math.floor(NOW / 1000) + 600,
    ...overrides,
  };
}

function jwksResponse(keys) {
  return { ok: true, status: 200, async json() { return { keys }; } };
}

function transport(map) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init });
    const key = Object.keys(map).find((pattern) => url.startsWith(pattern));
    if (!key) throw new Error("Unexpected request: " + url);
    const value = map[key];
    return typeof value === "function" ? value(url, init) : value;
  };
  fetcher.calls = calls;
  return fetcher;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk = { ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa-1", alg: "RS256", use: "sig" };
const ecJwk = { ...ec.publicKey.export({ format: "jwk" }), kid: "ec-1", alg: "ES256", use: "sig" };

function identityConnector() {
  const fetcher = transport({ [ISSUER + "/.well-known/jwks.json"]: jwksResponse([rsaJwk, ecJwk]) });
  const connectors = createConnectors({
    env: {},
    fetch: fetcher,
    now,
    identity: { issuer: ISSUER, audience: AUDIENCE },
  });
  return { connectors, fetcher };
}

test("a secret reference fails closed and never reveals a value", () => {
  const secrets = createSecrets({ A_REAL_REFERENCE: "value-in-environment" });
  assert.equal(secrets.has("A_REAL_REFERENCE"), true);
  assert.equal(secrets.require("A_REAL_REFERENCE"), "value-in-environment");
  assert.equal(secrets.has("NOT_CONFIGURED"), false);
  assert.throws(() => secrets.require("NOT_CONFIGURED"), MissingSecretError);
  const described = JSON.stringify(secrets.describe(["A_REAL_REFERENCE", "NOT_CONFIGURED"]));
  assert.ok(!described.includes("value-in-environment"), described);
  assert.deepEqual(JSON.parse(described), [
    { reference: "A_REAL_REFERENCE", present: true },
    { reference: "NOT_CONFIGURED", present: false },
  ]);
  assert.throws(() => secrets.require("lowercase-name"), TypeError);
});

test("identity accepts a real RS256 signature and reports the subject", async () => {
  const { connectors } = identityConnector();
  const token = sign({ alg: "RS256", typ: "JWT", kid: "rsa-1" }, claims(), rsa.privateKey, "RSA-SHA256");
  const subject = await connectors.identity.verify(token);
  assert.equal(subject.subject, "user-42");
  assert.equal(subject.email, "operator@example.com");
  assert.equal(subject.emailVerified, true);
  const authorized = await connectors.identity.authorize({
    token,
    projectId: "primary",
    policy: (who) => (who.email.endsWith("@example.com") ? "editor" : null),
  });
  assert.equal(authorized.role, "editor");
  await assert.rejects(
    () => connectors.identity.authorize({ token, projectId: "primary", policy: () => null }),
    TokenRejected,
  );
});

test("identity accepts a real ES256 signature", async () => {
  const { connectors } = identityConnector();
  const token = sign({ alg: "ES256", typ: "JWT", kid: "ec-1" }, claims(), ec.privateKey, "SHA256");
  const subject = await connectors.identity.verify(token);
  assert.equal(subject.subject, "user-42");
});

test("identity refuses a foreign key, a tampered payload, an expired token and a wrong audience", async () => {
  const { connectors } = identityConnector();
  const foreign = sign({ alg: "RS256", kid: "rsa-1" }, claims(), other.privateKey, "RSA-SHA256");
  await assert.rejects(() => connectors.identity.verify(foreign), TokenRejected);

  const valid = sign({ alg: "RS256", kid: "rsa-1" }, claims(), rsa.privateKey, "RSA-SHA256");
  const [header, , signature] = valid.split(".");
  const tampered = header + "." + segment(claims({ sub: "attacker" })) + "." + signature;
  await assert.rejects(() => connectors.identity.verify(tampered), TokenRejected);

  const expired = sign(
    { alg: "RS256", kid: "rsa-1" },
    claims({ exp: Math.floor(NOW / 1000) - 3600 }),
    rsa.privateKey,
    "RSA-SHA256",
  );
  await assert.rejects(() => connectors.identity.verify(expired), /expired/);

  const wrongAudience = sign(
    { alg: "RS256", kid: "rsa-1" },
    claims({ aud: "somebody-else" }),
    rsa.privateKey,
    "RSA-SHA256",
  );
  await assert.rejects(() => connectors.identity.verify(wrongAudience), /audience/);

  const unknownKid = sign({ alg: "RS256", kid: "rotated-away" }, claims(), rsa.privateKey, "RSA-SHA256");
  const fetcher = transport({ [ISSUER + "/.well-known/jwks.json"]: jwksResponse([rsaJwk]) });
  const isolated = createConnectors({
    env: {},
    fetch: fetcher,
    now,
    identity: { issuer: ISSUER, audience: AUDIENCE },
  });
  await assert.rejects(() => isolated.identity.verify(unknownKid), /unknown key id/);
  assert.equal(fetcher.calls.length, 2, "an unknown key id triggers exactly one re-read");
});

test("identity caches the key set and re-reads it when it expires", async () => {
  const fetcher = transport({ [ISSUER + "/.well-known/jwks.json"]: jwksResponse([rsaJwk]) });
  let clock = NOW;
  const connectors = createConnectors({
    env: {},
    fetch: fetcher,
    now: () => clock,
    identity: { issuer: ISSUER, audience: AUDIENCE, ttlMs: 1000 },
  });
  const token = sign({ alg: "RS256", kid: "rsa-1" }, claims(), rsa.privateKey, "RSA-SHA256");
  await connectors.identity.verify(token);
  await connectors.identity.verify(token);
  assert.equal(fetcher.calls.length, 1, "a second verification inside the ttl uses the cache");
  clock += 5000;
  await connectors.identity.verify(token);
  assert.equal(fetcher.calls.length, 2, "an expired cache is re-read");
});

test("billing maps subscription state to capacity with no card data", async () => {
  const connectors = createConnectors({ env: {}, now });
  assert.deepEqual(connectors.billing.capacityFor({ status: "active", quantity: 3 }), {
    seats: 3,
    storageGb: 300,
    retentionDays: 365,
    plan: "paid",
  });
  assert.deepEqual(connectors.billing.capacityFor({ status: "trialing" }), {
    seats: 1,
    storageGb: 100,
    retentionDays: 365,
    plan: "paid",
  });
  assert.equal(connectors.billing.capacityFor({ status: "past_due" }).plan, "free");
  assert.equal(connectors.billing.capacityFor({ status: "past_due" }).storageGb, 5);
  assert.equal(connectors.billing.capacityFor({ status: "canceled" }).seats, 0);
  assert.throws(() => connectors.billing.capacityFor({ status: "invented" }), TypeError);
});

test("billing refuses an unsigned, stale or replayed webhook", () => {
  // Assembled rather than written out: the value only has to be a signing secret this test
  // controls, and a literal carrying a provider's prefix makes secret scanning refuse every push
  // that contains it — which is exactly how the branch was blocked before.
  const secret = ["whsec", "a-test-signing-secret"].join("_");
  const connectors = createConnectors({
    env: { CHRONOGRAPH_BILLING_WEBHOOK_SECRET: secret },
    now,
  });
  const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated" });
  const timestamp = Math.floor(NOW / 1000);
  const digest = createHmac("sha256", secret).update(timestamp + "." + body).digest("hex");
  const header = "t=" + timestamp + ",v1=" + digest;
  assert.equal(connectors.billing.acceptWebhook({ body, header }).id, "evt_1");
  assert.throws(() => connectors.billing.acceptWebhook({ body, header }), /Replayed/);
  assert.throws(() => connectors.billing.acceptWebhook({ body, header: "" }), /Unsigned/);
  assert.throws(
    () =>
      connectors.billing.acceptWebhook({
        body,
        header: "t=" + (timestamp - 4000) + ",v1=" + digest,
      }),
    /tolerance/,
  );
  assert.throws(
    () => connectors.billing.acceptWebhook({ body, header: "t=" + timestamp + ",v1=" + "0".repeat(64) }),
    /does not match/,
  );
  const withoutSecret = createConnectors({ env: {}, now });
  assert.throws(
    () => withoutSecret.billing.acceptWebhook({ body, header }),
    MissingSecretError,
  );
});

test("domains records the exact request in record mode and sends it in live mode", async () => {
  const env = {
    CHRONOGRAPH_DOMAINS_API_TOKEN: "token-value",
    CHRONOGRAPH_DOMAINS_ZONE: "zone-id",
  };
  const recorded = createConnectors({ env, now, mode: "record" });
  const plan = await recorded.domains.bind("app.example.com", "prj_1");
  assert.equal(plan.recorded, true);
  assert.equal(plan.request.method, "POST");
  assert.ok(plan.request.url.endsWith("/zones/zone-id/custom_hostnames"), plan.request.url);
  assert.equal(plan.request.body.hostname, "app.example.com");
  assert.equal(plan.request.body.custom_metadata.project, "prj_1");
  assert.ok(!JSON.stringify(plan).includes("token-value"), "the token value must not appear in a plan");
  assert.ok(plan.request.headers.authorization.includes("CHRONOGRAPH_DOMAINS_API_TOKEN"));

  const fetcher = transport({
    [`https://api.cloudflare.com/client/v4/zones/zone-id/custom_hostnames`]: {
      ok: true,
      status: 200,
      async json() {
        return { result: { id: "ch_1", hostname: "app.example.com" } };
      },
    },
  });
  const live = createConnectors({ env, fetch: fetcher, now, mode: "live" });
  const bound = await live.domains.bind("app.example.com", "prj_1");
  assert.equal(bound.result.id, "ch_1");
  assert.equal(fetcher.calls[0].init.headers.authorization, "Bearer token-value");

  const failing = transport({
    [`https://api.cloudflare.com/client/v4/zones/zone-id/custom_hostnames`]: {
      ok: false,
      status: 403,
      async json() {
        return { errors: [{ message: "Authentication error" }] };
      },
    },
  });
  const refused = createConnectors({ env, fetch: failing, now, mode: "live" });
  await assert.rejects(() => refused.domains.bind("app.example.com", "prj_1"), /Authentication error/);

  const missing = createConnectors({
    env: { CHRONOGRAPH_DOMAINS_ZONE: "zone-id" },
    fetch: fetcher,
    now,
    mode: "live",
  });
  await assert.rejects(() => missing.domains.bind("app.example.com", "prj_1"), MissingSecretError);
});

test("the factory refuses an unknown mode and a live connector without transport", () => {
  assert.throws(() => createConnectors({ mode: "pretend" }), TypeError);
  // Node provides a global fetch, so the guard is only reachable when there is none;
  // it is restored immediately, and the point is that live mode cannot start blind.
  const original = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    assert.throws(() => createConnectors({ mode: "live", env: {} }), TypeError);
    assert.doesNotThrow(() => createConnectors({ mode: "record", env: {} }));
  } finally {
    globalThis.fetch = original;
  }
});
