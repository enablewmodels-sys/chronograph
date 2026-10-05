# Provider connectors (Layer 5)

Identity, billing and domains stay with their providers. These modules are the part
that is ours: verify what a provider signed, map it to something a project can act on,
and fail closed when a reference is missing.

```js
import { createConnectors } from "./index.mjs";

const connectors = createConnectors({
  env: process.env,          // secret references are read from here, by name
  mode: "record",            // "record" sends nothing and returns the request instead
  identity: { issuer: "https://identity.example", audience: "chronodb" },
});

const subject = await connectors.identity.verify(bearerToken);
const role = await connectors.identity.authorize({ token: bearerToken, projectId, policy });
const capacity = connectors.billing.capacityFor({ status: "active", quantity: 3 });
const plan = await connectors.domains.bind("app.example.com", projectId);
```

| Module | What it does | What it will not do |
| --- | --- | --- |
| `secrets.mjs` | resolves a reference name to a value at call time; `describe()` reports presence only | return a value to a caller, print one, or invent a default |
| `identity.mjs` | verifies RS256/ES256 signatures against a cached JWKS, checks `iss`, `aud`, `exp`, `nbf` and clock skew, maps the subject to a role | store a password, issue a token, or admit a subject no policy matches |
| `billing.mjs` | maps a subscription state to project capacity and verifies a signed webhook with a replay guard | accept an unsigned or stale event, or see card data |
| `domains.mjs` | binds a hostname through the Cloudflare SaaS API, or returns the exact request in record mode | send a request when its reference is missing |

Everything is created by one factory with an injected transport and clock, so the tests
run without a network and a caller can substitute either. `scripts/platform-connectors-test.mjs`
generates real key pairs and signs real tokens: a passing run means the verifier accepted
a genuine signature and refused a foreign key, a tampered payload, an expired token, a
wrong audience and an unknown key id.

The identity module is deliberately the only place that reads a token, and it never
writes one. Credential values live in the deployment environment or a vault; the contract
files reference them by name, and `scripts/platform-test.py` fails the build if a value
looks like it was written down.
