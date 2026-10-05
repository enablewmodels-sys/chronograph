#!/usr/bin/env node
/**
 * Evidence for the Layer 5 identity bridge (launch/private/managed/control-plane/provider-identity.mjs).
 *
 * WHY this is end to end instead of a mock: the bridge is only worth something if a token the
 * provider really signed opens a session the rest of the control plane already trusts. So this
 * file generates a real RSA key pair, signs real JWTs with node:crypto, serves the matching JWK
 * set through an injected fetch, and drives the real gateway over a temporary identity database.
 *
 * The provider token is a bearer secret: no assertion, log line or summary in this file prints
 * one, and one check proves the audit chain does not contain one either.
 *
 * Run with: node scripts/provider-identity-test.mjs
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../launch/private/managed/control-plane/gateway.mjs";
import { createProviderIdentity } from "../launch/private/managed/control-plane/provider-identity.mjs";
import { loadConfig } from "../launch/private/managed/control-plane/config.mjs";
import { random } from "../launch/private/managed/control-plane/store.mjs";

const CONTROL_PLANE = fileURLToPath(new URL("../launch/private/managed/control-plane/", import.meta.url));
const CONNECTOR = fileURLToPath(new URL("../deploy/platform/connectors/identity.mjs", import.meta.url));
const ISSUER = "https://issuer.test";
const AUDIENCE = "chronodb";
const PRIMARY = "primary";
const SECOND = "prj_0123456789abcdef";
const UNKNOWN = "prj_deadbeefdeadbeef";
const CLIENT_IP = "203.0.113.7";

let checks = 0;
let failures = 0;
function ok(value, message) { checks += 1; assert.ok(value, message); }
function equal(actual, expected, message) { checks += 1; assert.equal(actual, expected, message); }
function scenario(name, body) {
  test(name, async () => {
    try { await body(); }
    catch (error) { failures += 1; throw error; }
  });
}

// One summary line, always last, and a non-zero exit whenever a check failed.
process.on("exit", () => {
  const passed = failures === 0 && checks > 0;
  if (!passed) process.exitCode = 1;
  process.stdout.write(JSON.stringify({ passed, checks }) + "\n");
});

// ---------------------------------------------------------------------------
// Real keys, real signatures
// ---------------------------------------------------------------------------
const NOW = Math.floor(Date.now() / 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
function jwkFor(key, kid) {
  return { ...key.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
}
const JWKS = { keys: [jwkFor(publicKey, "test-key-1")] };

function segment(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function tokenFor({ key = privateKey, kid = "test-key-1", claims = {} } = {}) {
  const signingInput = segment({ alg: "RS256", typ: "JWT", kid }) + "." + segment({
    iss: ISSUER, aud: AUDIENCE, sub: "subject-1", email: "person@example.com", email_verified: true,
    exp: NOW + 300, iat: NOW, nbf: NOW - 10, ...claims,
  });
  return signingInput + "." + signBytes("RSA-SHA256", Buffer.from(signingInput), key).toString("base64url");
}

/** A key-set server that records the paths it was asked for. */
function stubFetch(keys) {
  const requested = [];
  const stub = async input => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requested.push(url.pathname);
    if (!keys[url.pathname]) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(keys[url.pathname]), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { stub, requested };
}

// ---------------------------------------------------------------------------
// Fixtures: the real gateway, over a temporary identity database
// ---------------------------------------------------------------------------
function configFor(root, identityProvider) {
  return {
    origin: "http://127.0.0.1:18991", database: join(root, "identity.sqlite"), secret: random(),
    tokens: { admin: `cg_${"a".repeat(16)}_${"a".repeat(64)}`, ingest: `cg_${"b".repeat(16)}_${"b".repeat(64)}`, read: `cg_${"c".repeat(16)}_${"c".repeat(64)}` },
    upstream: "http://127.0.0.1:18992", projectsRoot: join(root, "projects"), maxProjects: 3,
    projectPortStart: 18993, binary: "/usr/bin/false", ui: root, docs: root, superadminEmails: [],
    ...(identityProvider ? { identityProvider } : {}),
  };
}
async function fixture(identityProvider) {
  const root = await mkdtemp(join(tmpdir(), "chronograph-provider-identity-"));
  await mkdir(join(root, "projects"));
  const config = configFor(root, identityProvider);
  const app = await createGateway(config);
  for (const [id, name, external] of [[PRIMARY, "ChronoDB", 1], [SECOND, "Second", 0]]) {
    app.db.prepare("INSERT INTO cg_project (id,name,owner_id,state,created_at,external) VALUES (?,?,?,?,?,?)").run(id, name, "operator", "ready", Date.now(), external);
  }
  const originalFetch = globalThis.fetch;
  const client = () => {
    const cookies = new Map();
    return { cookies, async call(path, body, headers = {}) {
      const requestHeaders = {
        host: new URL(config.origin).host, "x-real-ip": CLIENT_IP,
        ...(body === undefined ? {} : { origin: config.origin, "content-type": "application/json" }),
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers,
      };
      const response = await app.handle(new Request(config.origin + path, {
        method: body === undefined ? "GET" : "POST", headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(";")[0], i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      const text = await response.text();
      let value = null;
      try { value = JSON.parse(text); } catch { value = null; }
      return { status: response.status, value, text, setCookie: response.headers.getSetCookie(), headers: response.headers };
    } };
  };
  return {
    app, config, client,
    sessionCount: () => app.db.prepare("SELECT COUNT(*) AS n FROM session").get().n,
    userCount: () => app.db.prepare("SELECT COUNT(*) AS n FROM user").get().n,
    memberRows: email => app.db.prepare("SELECT m.* FROM cg_project_member m JOIN user u ON u.id=m.user_id WHERE u.email=? ORDER BY m.created_at").all(email),
    audits: action => app.db.prepare("SELECT * FROM cg_audit WHERE action=? ORDER BY seq").all(action),
    useFetch(stub) { globalThis.fetch = stub; },
    async close() {
      globalThis.fetch = originalFetch;
      await app.projects.close();
      app.db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. config.mjs: the block is optional, normalised, and loud when malformed
// ---------------------------------------------------------------------------
async function configFixture(block) {
  const root = await mkdtemp(join(tmpdir(), "chronograph-provider-config-"));
  const secretFile = join(root, "session.secret");
  await writeFile(secretFile, random(), { mode: 0o600 });
  const tokenFiles = {};
  for (const scope of ["admin", "ingest", "read"]) {
    tokenFiles[scope] = join(root, scope + ".token");
    await writeFile(tokenFiles[scope], random(), { mode: 0o600 });
  }
  const path = join(root, "control.json");
  await writeFile(path, JSON.stringify({
    origin: "https://managed.test", port: 8090, database: join(root, "identity.sqlite"),
    projectsRoot: join(root, "projects"), secretFile, tokenFiles, upstream: "http://127.0.0.1:8080",
    ...(block === undefined ? {} : { identityProvider: block }),
  }), { mode: 0o600 });
  return { path, root };
}

scenario("config.mjs treats the identityProvider block as optional, normalises it, and refuses a malformed one", async () => {
  const absent = await configFixture(undefined);
  try {
    const config = await loadConfig(absent.path);
    equal(config.identityProvider, undefined, "an absent block must stay absent: the feature is off");
  } finally { await rm(absent.root, { recursive: true, force: true }); }

  const present = await configFixture({
    issuer: "https://login.example.com/", audience: " chronodb ",
    jwksPath: "/keys", policy: { emailDomains: ["Example.com", "example.com", "staff.example.org"], defaultRole: "editor" },
  });
  try {
    const config = await loadConfig(present.path);
    equal(config.identityProvider.issuer, "https://login.example.com", "the issuer is kept as the exact origin the token's iss claim must equal");
    equal(config.identityProvider.audience, "chronodb", "the audience is trimmed");
    equal(config.identityProvider.jwksPath, "/keys", "a configured key-set path is kept");
    equal(config.identityProvider.policy.defaultRole, "editor", "the role is validated against the existing roles");
    equal(JSON.stringify(config.identityProvider.policy.emailDomains), JSON.stringify(["example.com", "staff.example.org"]), "domains are lower-cased and de-duplicated");
  } finally { await rm(present.root, { recursive: true, force: true }); }

  const malformed = [
    "http://login.example.com",
    "https://login.example.com/tenant",
    "",
  ];
  for (const issuer of malformed) {
    const { path, root } = await configFixture({ issuer, audience: "chronodb" });
    try {
      checks += 1;
      await assert.rejects(loadConfig(path), "issuer " + JSON.stringify(issuer) + " must fail startup");
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  const blocks = [
    { issuer: ISSUER },
    { issuer: ISSUER, audience: "" },
    { issuer: ISSUER, audience: "chronodb", policy: { defaultRole: "superuser" } },
    { issuer: ISSUER, audience: "chronodb", policy: { emailDomains: "example.com" } },
    { issuer: ISSUER, audience: "chronodb", policy: { emailDomains: ["person@example.com"] } },
    { issuer: ISSUER, audience: "chronodb", policy: { emailDomains: ["not a domain"] } },
    { issuer: ISSUER, audience: "chronodb", jwksPath: "well-known/jwks.json" },
    { issuer: ISSUER, audience: "chronodb", module: "deploy/platform/connectors/identity.mjs" },
    { issuer: ISSUER, audience: "chronodb", policy: [] },
  ];
  for (const block of blocks) {
    const { path, root } = await configFixture(block);
    try {
      checks += 1;
      await assert.rejects(loadConfig(path), "a malformed block must fail startup: " + JSON.stringify(block));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

// ---------------------------------------------------------------------------
// The shared opted-in deployment
// ---------------------------------------------------------------------------
const main = await fixture({
  issuer: ISSUER, audience: AUDIENCE, jwksPath: "/.well-known/jwks.json",
  defaultProject: null, module: null,
  policy: { emailDomains: ["example.com"], defaultRole: "editor" },
});
const jwks = stubFetch({ "/.well-known/jwks.json": JWKS });
main.useFetch(jwks.stub);
after(async () => { await main.close(); });

const validToken = tokenFor();
const foreignToken = tokenFor({ key: foreign.privateKey });
const expiredToken = tokenFor({ claims: { exp: NOW - 3600 } });
const wrongAudience = tokenFor({ claims: { aud: "someone-else" } });
const unverifiedToken = tokenFor({ claims: { email_verified: false } });
const outsideDomain = tokenFor({ claims: { email: "person@other.test", sub: "subject-2" } });

scenario("a valid provider token opens a project session and returns the mapped role", async () => {
  const client = main.client();
  const before = main.sessionCount();
  const result = await client.call("/managed/provider-session", { token: validToken, projectId: PRIMARY });
  equal(result.status, 200, "a genuine token must be accepted");
  equal(result.value.user.email, "person@example.com", "the session belongs to the verified address");
  equal(result.value.user.role, "editor", "the policy's defaultRole is the new membership's role");
  equal(result.value.project.id, PRIMARY, "the requested project is the session's project");
  equal(result.value.projects.length, 1, "the account now belongs to exactly one project");
  equal(result.value.projects[0].id, PRIMARY, "the one it exchanged for");
  equal(result.value.projects[0].role, "editor", "with the policy's role");
  ok(result.value.user.role !== undefined && result.value.user.needsActivation === false, "the account is active, not pending");
  equal(main.sessionCount(), before + 1, "exactly one control-plane session was created");

  const cookie = result.setCookie[0];
  ok(cookie.startsWith("chronograph.session_token="), "the sign-in path's session cookie is the one that was set");
  ok(cookie.includes("HttpOnly"), "the session cookie is HttpOnly");
  const asJson = JSON.stringify(result.value);
  ok(!asJson.includes(validToken), "the response body never echoes the provider token");

  // The cookie the exchange set has to work on the ordinary session route, unchanged.
  const session = await client.call("/managed/session");
  equal(session.status, 200, "the exchanged session is a normal session");
  equal(session.value.user.email, "person@example.com", "the session route resolves the same account");
  equal(session.value.project.id, PRIMARY, "the exchanged project stays bound to the session");
  const projects = await client.call("/managed/projects");
  equal(projects.status, 200, "the session authorises ordinary project requests");
  equal(projects.value.projects.length, 1, "and only the project the policy granted");

  equal(main.userCount(), 1, "one account was created in total");
  const members = main.memberRows("person@example.com");
  equal(members.length, 1, "the account is a member of one project");
  equal(members[0].status, "active", "membership is active, not a pending invitation");
  equal(members[0].role, "editor", "and carries the policy's role");

  equal(JSON.stringify(jwks.requested), JSON.stringify(["/.well-known/jwks.json"]), "the key set was fetched from the well-known path");
});

scenario("a token that cannot be trusted is refused and creates no session", async () => {
  const cases = [
    [foreignToken, 401, "signed by a key the issuer never published"],
    [expiredToken, 401, "expired"],
    [wrongAudience, 401, "issued for another audience"],
    [unverifiedToken, 403, "without a confirmed address"],
    [outsideDomain, 403, "from a domain the allowlist excludes"],
    ["not-a-jwt", 401, "that is not a token at all"],
  ];
  for (const [token, status, why] of cases) {
    const client = main.client();
    const before = main.sessionCount();
    const result = await client.call("/managed/provider-session", { token, projectId: PRIMARY });
    equal(result.status, status, "a token " + why + " must be refused");
    equal(main.sessionCount(), before, "a refused exchange must not create a session");
    const session = await client.call("/managed/session");
    equal(session.value.user, null, "and must not leave an authenticated cookie behind");
    ok(!JSON.stringify(result.value).includes(token), "the refusal never echoes the token");
  }
  equal(main.userCount(), 1, "no refused case created an account");
  ok(main.memberRows("person@other.test").length === 0, "no refused case granted a membership");
});

scenario("an unknown project is refused with the gateway's own problem shape", async () => {
  const client = main.client();
  const before = main.sessionCount();
  const result = await client.call("/managed/provider-session", { token: validToken, projectId: UNKNOWN });
  equal(result.status, 404, "an unknown project is a 404, like every other missing project");
  equal(result.value.error.message, "Project not found.", "with the message the gateway already uses");
  ok(typeof result.value.requestId === "string" && result.value.error.code === "ACCESS_ERROR", "and the gateway's problem shape");
  equal(main.sessionCount(), before, "no session is created for an unknown project");
});

scenario("exchanging the same subject twice returns a working session both times", async () => {
  const first = await main.client().call("/managed/provider-session", { token: validToken, projectId: SECOND });
  const second = await main.client().call("/managed/provider-session", { token: validToken, projectId: SECOND });
  equal(first.status, 200, "the first exchange signs in");
  equal(second.status, 200, "a retry signs in too, rather than failing on its own earlier grant");
  ok(first.value.user.sessionId !== second.value.user.sessionId, "each exchange opens its own session");
  equal(second.value.project.id, SECOND, "the second exchange may name another project that already exists");
  equal(main.userCount(), 1, "no duplicate account");
  equal(main.memberRows("person@example.com").length, 2, "one membership per project, no duplicates");
});

scenario("the audit row is written once per exchange and never contains the token", async () => {
  const before = main.audits("identity.provider_session").length;
  const client = main.client();
  equal((await client.call("/managed/provider-session", { token: validToken, projectId: PRIMARY })).status, 200, "a successful exchange is audited");
  equal((await main.client().call("/managed/provider-session", { token: expiredToken, projectId: PRIMARY })).status, 401, "a refused exchange is audited too");
  const rows = main.audits("identity.provider_session");
  equal(rows.length, before + 2, "exactly one row per exchange, success or failure");
  equal(rows.at(-2).outcome, "success", "the success is recorded as such");
  equal(rows.at(-1).outcome, "denied", "the refusal is recorded as such");
  equal(JSON.stringify(rows.at(-2).target), JSON.stringify(PRIMARY), "the row names the project, not the token");
  const chain = JSON.stringify(main.app.db.prepare("SELECT * FROM cg_audit").all());
  for (const token of [validToken, foreignToken, expiredToken, unverifiedToken]) {
    ok(!chain.includes(token), "no audit row may contain a provider token");
  }
});

scenario("state-changing requests keep the gateway's origin, content-type and rate checks", async () => {
  const crossOrigin = await main.client().call("/managed/provider-session", { token: validToken }, { origin: "https://evil.test" });
  equal(crossOrigin.status, 403, "another origin cannot use the bridge");
  const noOrigin = await main.client().call("/managed/provider-session", { token: validToken }, { origin: "" });
  equal(noOrigin.status, 403, "no origin at all is refused as well");
  const wrongType = await main.client().call("/managed/provider-session", { token: validToken }, { "content-type": "text/plain" });
  equal(wrongType.status, 415, "a non-JSON body is refused before it is read");
  const wrongMethod = await main.client().call("/managed/provider-session");
  equal(wrongMethod.status, 405, "only POST opens a session");

  const before = main.audits("identity.provider_session").length;
  let last = null;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    last = await main.client().call("/managed/provider-session", { token: validToken, projectId: PRIMARY }, { "x-real-ip": "203.0.113.99" });
  }
  equal(last.status, 429, "one client address is limited per minute");
  equal(last.headers.get("retry-after"), "60", "and is told when to retry");
  equal(main.audits("identity.provider_session").length, before + 20, "the limited attempt is never audited as an exchange");
});

// ---------------------------------------------------------------------------
// A deployment that grants every confirmed address, on a custom key-set path
// ---------------------------------------------------------------------------
scenario("without an allowlist every confirmed address receives defaultRole, through the configured key-set path", async () => {
  const custom = await fixture({
    issuer: ISSUER, audience: AUDIENCE, jwksPath: "/keys", module: CONNECTOR, defaultProject: null,
    policy: { emailDomains: [], defaultRole: "viewer" },
  });
  const customJwks = stubFetch({ "/keys": JWKS });
  custom.useFetch(customJwks.stub);
  try {
    const result = await custom.client().call("/managed/provider-session", {
      token: tokenFor({ claims: { email: "contractor@outside.test", sub: "subject-9" } }), projectId: PRIMARY,
    });
    equal(result.status, 200, "an explicitly configured bridge with no allowlist admits a confirmed address");
    equal(result.value.user.role, "viewer", "the configured defaultRole is the role");
    equal(result.value.project.id, PRIMARY, "and the caller's only project is the default project");
    equal(JSON.stringify(customJwks.requested), JSON.stringify(["/keys"]), "the key set was read from the configured path");
  } finally { await custom.close(); }
});

// ---------------------------------------------------------------------------
// The safety property: no block, no feature
// ---------------------------------------------------------------------------
scenario("without the block the route does not exist and sign-in is untouched", async () => {
  const plain = await fixture(undefined);
  // Any outbound call is a failure here: with the block absent the bridge must not even try to
  // read a key set, let alone verify anything.
  let fetched = 0;
  plain.useFetch(async () => { fetched += 1; throw new Error("the bridge must not fetch anything while it is off"); });
  try {
    checks += 1;
    assert.throws(() => createProviderIdentity({ config: plain.config, projects: plain.app.projects, identity: plain.app }), TypeError, "the bridge refuses to build without a block");
    const result = await plain.client().call("/managed/provider-session", { token: validToken, projectId: PRIMARY });
    equal(result.status, 404, "the route is absent, like any other route this deployment does not have");
    equal(result.value.error.message, "This workspace operation is not available.", "with the gateway's existing problem message");
    ok(typeof result.value.requestId === "string", "and the gateway's existing problem shape");
    equal(plain.sessionCount(), 0, "nothing was created by the attempt");
    equal(plain.userCount(), 0, "and no account appeared");

    // The normal sign-in path, exercised on the same deployment, still works.
    const invite = await plain.app.issueInvite({ email: "owner@example.com", name: "Owner", role: "owner" });
    const invitation = new URLSearchParams(new URL(invite.url).hash.slice(1)).get("token");
    const client = plain.client();
    const password = "temporal memory example passphrase";
    equal((await client.call("/api/auth/reset-password", { token: invitation, newPassword: password })).status, 200, "an invitation can still set a password");
    equal((await client.call("/api/auth/sign-in/email", { email: invite.email, password })).status, 200, "email sign-in still works");
    const session = await client.call("/managed/session");
    equal(session.value.user.email, "owner@example.com", "and the session route still resolves it");
    equal(session.value.project.id, PRIMARY, "with the project the invitation created");
    equal(fetched, 0, "and nothing in that flow tried to reach the identity provider");
  } finally { await plain.close(); }
});
