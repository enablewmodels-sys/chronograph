# Platform layers

ChronoDB is storage and transport for neural, physical-AI and robotics data. Five layers, with a
clear boundary around what this repository implements and what your existing providers keep doing.

| Layer | Implemented here | Boundary |
| --- | --- | --- |
| 1 Data ingestion | Source registry, BrainFlow, LSL, EDF/BDF/FIF/BrainVision/EEGLAB, CSV/NPY/tabular, synthetic board | Device libraries and file readers run on your machine |
| 2 Temporal graph storage | Valid time and transaction time, replay at any T, durable branches, causal path queries | Single writer, durable journal, immutable assets |
| 3 Developer SDK | Python, TypeScript and a WASM module that all execute one `decoder-v1` artifact; the remaining languages consume the shared contract | The server never runs your model |
| 4 App hosting | `appctl`: one container per app with persistent storage, a health gate, preview then promote by image digest, rollback, and hostname binding | Store publishing and TLS issuance stay with your own accounts and providers |
| 5 Identity, auth, billing | Provider-neutral connectors | Ory Kratos/SuperTokens/Authgear, Stripe and Cloudflare for SaaS stay yours |

## Layer 1 - ingestion

See [device and file formats](FORMATS.md). One registry, one writer, many declarations: a board or
a format is data, and the synthetic board is the only device the tests exercise.

The catalogue is generated from the installed driver, not written by hand
(`scripts/export-brainflow-catalog.py`): 64 board IDs, 18 vendors, 89 presets and 3 transports in
BrainFlow 5.23.0, with any device the installed driver cannot provide named rather than hidden — the
set moves with the driver, so a vendor reported unavailable on one version is simply available on the
next. The console reads that
same file in two places — the source picker that builds your command and the device catalogue — so
what you select and what the SDK accepts cannot drift apart.

## Layer 2 - temporal graph storage

Every relationship version carries a valid-time interval; the journal carries transaction order.
`as_of(T)` replays exactly what was active at T. A fork freezes the state active at a chosen time
and isolates later writes, and one writer serves the parent and every branch: branch batches can
even commit in a single frame. Causal paths walk recorded lineage from a prediction back to the
raw recording. See [branches](BRANCHES.md) and [temporal model](TUTORIAL.md).

## Layer 3 - SDKs

Python is the research interface: the encoder registry, the decoder adapters and the CLI.

TypeScript carries the same operations for applications — `Client` for the graph API, `BCIClient`
for windows and causal paths, the decision-model helpers — and the decoder as well.
`sdk/typescript/src/decoder.ts` loads `crates/chronograph-wasm` and moves bytes through its
linear-memory ABI, so a browser executes the same `decoder-v1` reader as Python, the native
binary and Rust. `sdk/typescript/test/decoder.mjs` is the evidence rather than the claim: it
builds one artifact with `scripts/decoder-fixture.py`, decodes five windows through the module
and compares every probability with Python's own output — a maximum delta of 1.1e-16 on a
272,620-byte module.

Java, C++, C#, Go, Dart and the quantum hosts consume the shared OpenAPI contract.
`scripts/sdk/conformance.mjs` drives Python, TypeScript, Go, Java, C++, C#, and Dart against a
running engine; the Java, C++ and C# SDK directories hold no test sources in this tree, and no
quantum host is included in that runner, so those specific suites are unverified here rather than
claimed.

## Layer 4 - app hosting

Intended shape: a hosted app is a project-scoped container with persistent storage, a health check
and a domain. It is not serverless: a database needs durable local storage, and the engine keeps
its journal and assets on disk under one owning writer.

The manifest for such an app is `deploy/platform/app.example.json`, called `chronograph.app.json`
once copied into a project. It declares `kind` (container, web or mobile), the build context, the
served port and health path, the **persistent** mount and size, the hostnames plus the domain
provider that issues them, and the environment as plain values or `secret-ref` names. It also
names the store artifacts, because a mobile build is a first-class target rather than an
afterthought:

| Field | Meaning |
| --- | --- |
| `kind` | container, web or mobile |
| `build` | context and Dockerfile; one image per app |
| `run` | port, health path, replicas |
| `persistence` | mount and size. A database needs durable local storage, so this is never serverless |
| `domains` | hostname plus the provider (`cloudflare-saas`) and the secret reference it needs |
| `env` | `plain` values and `secret-ref` names; values are never stored here |
| `stores` | `play` with an AAB, `app-store` with an IPA, and what the operator must supply |

`deploy/platform/appctl.mjs` is the runtime: `plan`, `build`, `deploy`, `promote`, `rollback`,
`status`, `logs`, `destroy` and `bind-domain`, driving docker or podman through one argv builder
that a dry-run driver records instead of executing. `deploy --preview` runs the app on its own
port, `promote` re-tags the exact image digest the preview ran and refuses an unhealthy or unknown
preview, and every action appends to a ledger that holds reference names rather than values. The
persistence size is a ceiling: a container with database-like environment names and no persistent
mount is refused, and so is a volume whose recorded size disagrees with the manifest.

The product reaches it too. The console's **Apps** page lists a project's apps with health and the
active image digest and offers plan, deploy, promote, roll back and destroy, behind
`/managed/apps*` in the control plane. Hosting is opt-in through a `hosting` block in the
configuration: with it absent every one of those routes answers 404 and the page says hosting is not
enabled. A deploy only ever names a manifest that already exists under the project's own manifests
directory — the request cannot supply a manifest, a path or a runtime — a plan is the one call a
viewer may make, mutations need an admin, destroying needs the owner plus a confirmation echo, and
the child process is spawned with an argv array, a minimal environment in which a secret reference
travels by name only, and bounded time and output.

What is still not here: a multi-tenant scheduler with a queue, horizontal scaling (`replicas > 1`
is refused rather than silently downgraded), and a filesystem-level volume quota, which needs
host-specific storage options. `scripts/appctl-test.mjs` covers 34 checks on the dry-run driver;
the live docker and Cloudflare paths are written but only exercised where a runtime and a
credential exist.

### Publishing to a store

The build is automatable; the submission is not. Producing an Android App Bundle or an iOS
archive and uploading it to Google Play Console or App Store Connect needs the operator's own
account, app record, bundle identifier and signing keys. This repository can build the artifact
and can drive the console while the operator is signed in; it will not submit unattended, and it
never asks for a signing secret in chat. Connections and credentials for that step belong in
Settings, not in a repository file.

What stays with you: store submission. Producing an Android App Bundle or iOS archive and
uploading it to Google Play Console or App Store Connect requires your own account, app record
and signing keys. The platform can build and can drive the console while you are signed in; it
will not submit unattended and never asks for a signing secret in chat.

## Layer 5 - identity, auth, billing, domains

These are connector boundaries, not reimplementations: the provider stays authoritative, and the code
here is the part that is ours — verifying what a provider signed, mapping it to something a project
can act on, and failing closed when a reference is missing.

| Concern | Options | What ChronoDB does | Implementation |
| --- | --- | --- | --- |
| Identity | `ory-kratos`, `supertokens`, `authgear` | Verifies RS256/ES256 against a cached JWKS, checks `iss`, `aud`, `exp`, `nbf` and skew, then maps the subject to a project role through your policy | `deploy/platform/connectors/identity.mjs` |
| Billing | `stripe` | Maps a subscription state to project capacity and requires a signed, unexpired, unseen event before capacity changes; no card data reaches this repository | `deploy/platform/connectors/billing.mjs` |
| Domains | `cloudflare-saas` | Binds a hostname to a project, or returns the exact request it would send in record mode; an unconfigured reference fails closed | `deploy/platform/connectors/domains.mjs` |

Every connector is built by one factory with an injected transport and clock
(`deploy/platform/connectors/index.mjs`), so the tests run without a network and a deployment can
substitute either. `scripts/platform-connectors-test.mjs` generates real key pairs and signs real
tokens: the verifier is proven to accept a genuine signature and refuse a foreign key, a tampered
payload, an expired token, a wrong audience and an unknown key id.

The machine-readable form of this table is `deploy/platform/connectors.json`. Every layer names
its boundary, the artifacts that implement it, and the environment variables it needs, and no
entry may carry a value: `scripts/platform-test.py` fails the build if a contract file holds
something that looks like a credential or points at an artifact that does not exist. That is the
whole point of the layer, so it is checked rather than described.

Secret values live in the deployment vault or your own environment. Configuration references them
by name, and this repository never stores a provider credential.

## What is not claimed

- No hardware certification, medical device status, clinical interpretation or safety-critical
  control. No regulated-health hosting agreement.
- No PCI scope: card data stays with the billing provider.
- No guarantee that a store or a domain provider approves a submission.
