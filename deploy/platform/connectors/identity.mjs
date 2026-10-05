// Identity is delegated: this verifies a token a provider issued and maps the
// verified subject to a project role. It never sees a password and never issues one.
//
// Only node:crypto is used, so the check does not depend on the provider's SDK and
// the same code runs against Ory Kratos, SuperTokens, Authgear or a plain OIDC issuer.
import { createPublicKey, createVerify, timingSafeEqual } from "node:crypto";

const ALGORITHMS = { RS256: "RSA-SHA256", ES256: "SHA256" };
const DEFAULT_TTL_MS = 300_000;
const MAX_JWKS_AGE_MS = 3_600_000;

/** Raised when a token is present but cannot be trusted. */
export class TokenRejected extends Error {
  constructor(reason, detail) {
    super(reason + (detail ? ": " + detail : ""));
    this.name = "TokenRejected";
    this.code = "TOKEN_REJECTED";
    this.reason = reason;
  }
}

function decodeSegment(segment, what) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new TokenRejected("malformed " + what);
  }
}

function audienceMatches(claim, expected) {
  const list = Array.isArray(claim) ? claim : [claim];
  return list.some((value) => value === expected);
}

/**
 * A JWKS-backed verifier with a bounded cache.
 *
 * @param {object} options
 * @param {(url: string) => Promise<Response>} options.fetch transport, injected for tests
 * @param {() => number} options.now clock in milliseconds, injected for tests
 * @param {string} options.issuer the only issuer whose keys are fetched
 * @param {string} options.audience the only audience that is accepted
 * @param {number} [options.ttlMs] cache lifetime for a key set
 * @param {number} [options.clockSkewSeconds] tolerance for exp and nbf
 */
export function createVerifier({
  fetch: fetcher,
  now,
  issuer,
  audience,
  ttlMs = DEFAULT_TTL_MS,
  clockSkewSeconds = 60,
}) {
  if (typeof issuer !== "string" || !issuer.startsWith("https://"))
    throw new TypeError("issuer must be an https URL");
  let cached = null;

  async function keySet(force = false) {
    const at = now();
    // A key set is cached but never forever: a provider that rotates keys must be
    // re-read, and a rotated key must not be trusted past the maximum age.
    if (!force && cached && at - cached.at < ttlMs && at - cached.at < MAX_JWKS_AGE_MS)
      return cached.keys;
    const response = await fetcher(issuer.replace(/\/$/, "") + "/.well-known/jwks.json");
    if (!response.ok)
      throw new TokenRejected("jwks unavailable", String(response.status));
    const body = await response.json();
    if (!body || !Array.isArray(body.keys) || body.keys.length === 0)
      throw new TokenRejected("jwks empty");
    cached = { at, keys: body.keys };
    return cached.keys;
  }

  function publicKey(jwk) {
    try {
      return createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      throw new TokenRejected("unusable jwk", String(jwk?.kid));
    }
  }

  function checkSignature(header, signingInput, signature, jwk) {
    const algorithm = ALGORITHMS[header.alg];
    if (!algorithm) throw new TokenRejected("unsupported algorithm", String(header.alg));
    if (jwk.kty === "EC" && header.alg !== "ES256")
      throw new TokenRejected("algorithm does not match the key type");
    if (jwk.kty === "RSA" && header.alg !== "RS256")
      throw new TokenRejected("algorithm does not match the key type");
    const verifier = createVerify(algorithm);
    verifier.update(signingInput);
    verifier.end();
    const ok =
      header.alg === "ES256"
        ? verifier.verify({ key: publicKey(jwk), dsaEncoding: "ieee-p1363" }, signature)
        : verifier.verify(publicKey(jwk), signature);
    if (!ok) throw new TokenRejected("bad signature");
  }

  async function verify(token) {
    if (typeof token !== "string" || token.split(".").length !== 3)
      throw new TokenRejected("not a jwt");
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    const header = decodeSegment(encodedHeader, "header");
    const claims = decodeSegment(encodedPayload, "payload");
    if (header.typ && header.typ !== "JWT") throw new TokenRejected("unexpected token type");

    const keys = await keySet();
    let jwk = keys.find((key) => key.kid === header.kid);
    if (!jwk) {
      // An unknown key id is the signature of a rotation: re-read once, then refuse.
      jwk = (await keySet(true)).find((key) => key.kid === header.kid);
    }
    if (!jwk) throw new TokenRejected("unknown key id", String(header.kid));
    checkSignature(header, encodedHeader + "." + encodedPayload, Buffer.from(encodedSignature, "base64url"), jwk);

    const at = Math.floor(now() / 1000);
    const skew = clockSkewSeconds;
    if (claims.iss !== issuer) throw new TokenRejected("wrong issuer", String(claims.iss));
    if (audience !== undefined && !audienceMatches(claims.aud, audience))
      throw new TokenRejected("wrong audience");
    if (typeof claims.exp !== "number" || claims.exp + skew < at)
      throw new TokenRejected("expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > at)
      throw new TokenRejected("not yet valid");
    if (claims.sub === undefined) throw new TokenRejected("no subject");

    return {
      subject: String(claims.sub),
      email: typeof claims.email === "string" ? claims.email : null,
      emailVerified: claims.email_verified === true,
      issuer: claims.iss,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      claims,
    };
  }

  /**
   * Verify a bearer token and map it to a project role. A token with no matching
   * policy is refused: an authenticated stranger is still a stranger.
   *
   * @param {object} options promise of the project and the role policy
   */
  async function authorize({ token, projectId, policy }) {
    const subject = await verify(token);
    const role = policy ? policy(subject, projectId) : null;
    if (!role) throw new TokenRejected("no policy for this subject", subject.email || subject.subject);
    return { ...subject, projectId, role };
  }

  return { verify, authorize, issuer, audience };
}

/** Constant-time comparison for values that must not leak through timing. */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}
