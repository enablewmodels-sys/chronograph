# What is live, what is inert, and what turns it on

This page exists so nobody has to guess. Every row was verified against the running
deployment or the test named beside it. "Inert by configuration" means the code is
deployed and tested but deliberately does nothing until an operator supplies the named
setting or credential — nothing half-on, and nothing pretending to be on.

## Live now

| Capability | Evidence |
| --- | --- |
| Temporal graph engine, forks, one writer, causal paths | `cargo test --release -p chronograph-db` — 33 tests; `scripts/bci-branch-test.py` |
| Static musl engine binary | `file` reports `statically linked`; deployed sha256 equals the build tree |
| Ingestion: 64 BrainFlow boards, 18 vendors, LSL, EDF/BDF/FIF/BrainVision/EEGLAB, CSV/NPY | `scripts/bci-formats-test.py` — 2,902 checks |
| Source picker reaching every board | `ui/e2e/catalogue.spec.ts` — walks the widget, 64/64 selectable |
| Decoder: Python, TypeScript, WASM, and in the browser | `sdk/typescript/test/decoder.mjs` and `scripts/bci-wasm-test.py` — parity 1.1e-16; the live console decodes the artifact it serves |
| Console sign-in, projects, team, secrets, audit | `ui/e2e/managed-auth.spec.ts`; control-plane suite 44 tests / 42 pass / 0 fail |
| Every console page, and the page it claims to be | `ui/e2e/console-sweep.spec.ts` — 13 console pages plus the operator panel, each asserted against copy only that page draws, so a redirect or a page that rendered one error notice fails |
| The console's own controls | `ui/e2e/console-actions.spec.ts` — 6/6 against a real deployment: an API key created then revoked, a secret stored, a reader key issued, an invitation answered or refused with its reason, a durable branch created, a backup identified by its new ID, and the sign-in form itself |
| One deployment, one deployment floor | `minimumFreeBytes` (default 5 GiB) is read by the graph-write guard, project provisioning and the operator panel's disk warning, each naming the measurement; the loader pins 64 MiB/1 TiB as the accepted bounds |
| A refusal says what to do | The gateway masks an unexpected failure but passes through a deliberate one, so "writes are paused because storage is low: 3200 MiB free, below this deployment's 4096 MiB floor" reaches the reader; `test/errors.test.mjs` |
| The decoder, pressed rather than described | `console-sweep.spec.ts` runs the browser decoder against a real deployment and requires a token back (13 pages + operator panel + decode = 15) |
| The same pages against a real deployment | `scripts/managed-local.mjs` (real gateway, real engine, real session) with `CHRONOGRAPH_SWEEP_ORIGIN`; needs `ui/dist-managed` and `target/release/chronograph-server`, both build artifacts |
| Sessions that survive a quiet afternoon | 30-day lifetime that the browser cookie *and* the server row both follow, a 14-day idle window, and an explained sign-out; the policy literals and both sides of the idle boundary are asserted in the control-plane suite |
| Operator panel | allowlisted operator only; non-operators are told, not bounced; verified against a real deployment in `console-sweep.spec.ts` |
| Docs, both editions, TLS, asset caching at the edge | every chapter 200 on chronodb.co and the Community site; `cf-cache-status: HIT` |
| Scheduled backups and per-project backup freshness | `chronograph-managed-backup` exit 0; health report `ok: true` for every project |
| Host monitor | `chronograph-monitor.timer`; `/var/lib/chronograph-managed/operational-health.json` |
| Layer 4 runtime (plan, build, deploy, promote, rollback, destroy, bind-domain) | `scripts/appctl-test.mjs` — 35 checks, including a build context that cannot escape its manifest |
| Layer 4 from the console | `scripts/hosting-test.mjs` — 12 scenarios, 386 checks |
| Layer 5 connectors (identity verification, billing mapping, domain binding) | `scripts/platform-connectors-test.mjs` — 9 checks with real keys and signatures |

## Deployed, inert until configured

| Capability | Turn it on with | Test that proves it |
| --- | --- | --- |
| Console Apps page and `/managed/apps*` routes | `hosting: {enabled, stateRoot, manifestsRoot, runtime}` in the control-plane configuration | `scripts/hosting-test.mjs` (hosting absent ⇒ 404 everywhere) |
| Provider-token sign-in (`POST /managed/provider-session`) | `identityProvider: {issuer, audience, jwksPath, policy}` | `scripts/provider-identity-test.mjs` — 108 checks |
| Operational alerts | `alertWebhook` (https) or `CHRONOGRAPH_ALERT_WEBHOOK` | `scripts/alerts-test.py` — 14 checks; the status file reports `destination: none` today |
| Billing capacity (subscription → seats, storage, retention) | `CHRONOGRAPH_BILLING_API_KEY`, `CHRONOGRAPH_BILLING_WEBHOOK_SECRET` | `scripts/platform-connectors-test.mjs` |
| Hostname binding through Cloudflare SaaS | `CHRONOGRAPH_DOMAINS_API_TOKEN`, `CHRONOGRAPH_DOMAINS_ZONE`, then `appctl bind-domain` | `scripts/platform-connectors-test.mjs` (record mode and fail-closed) |
| Email signup and password recovery | a mail provider in the control-plane configuration (`mail`) | control-plane suite; the console says "not available yet" while it is unset |
| Google and GitHub sign-in | the OAuth credential files the configuration points at | `ui/e2e/managed-auth.spec.ts` |

## Not built, and why

| Capability | Why it is not here |
| --- | --- |
| Publishing the SDKs to npm and PyPI | The packages are built and install-verified (`dist/sdk/…whl`, `…sdk-…tgz`); uploading needs registry tokens that a repository must not hold |
| Submitting to Google Play or the App Store | Needs the operator's own account, app record and signing keys; `appctl` builds the artifact and will not submit unattended |
| Off-host backup, replication, automatic failover | Needs a destination and credentials; today the backup is local with a rotation, and an encrypted copy was taken off the instance by hand |
| A multi-tenant scheduler with a queue | Deliberate: one writer and durable local storage per project is the model. `replicas > 1` is refused rather than silently downgraded |
| A filesystem-level volume quota | Docker's volume API has no portable size option; the declared size is enforced as an appctl ceiling and verified back from a label |
| Store publishing from the console | Same as store submission: it is an account-bound step, not a code path |

## How to check this page has not drifted

```sh
node scripts/appctl-test.mjs                     # 35
node scripts/hosting-test.mjs                    # 386
node scripts/platform-connectors-test.mjs        # 9
node scripts/provider-identity-test.mjs          # 108
cd launch/private/managed/control-plane && node --test test/*.test.mjs   # 44 tests, 42 pass
cd ui && node node_modules/@playwright/test/cli.js test --project=desktop-chromium   # 39 passed, 8 skipped
#   the eight skips all need a real deployment: the operator panel, the decoder click, and the
#   six control tests in console-actions.spec.ts

# The operator panel and the 13 pages against a real deployment, not a mock. The password
# is generated by managed-local.mjs into a 0600 file; it is never printed.
node scripts/managed-local.mjs --port 19090 --data /tmp/chronodb-local &
cd ui && CHRONOGRAPH_SWEEP_ORIGIN=http://127.0.0.1:19090 \
  CHRONOGRAPH_SWEEP_EMAIL=operator@chronodb.local \
  CHRONOGRAPH_SWEEP_PASSWORD="$(cat /tmp/chronodb-local/owner-password)" \
  CHRONOGRAPH_SWEEP_STATE=/tmp/chronodb-local/sweep-session.json \
  node node_modules/@playwright/test/cli.js test e2e/console-sweep.spec.ts \
  --project=desktop-chromium                                     # 15 passed

# Then the controls, not just the pages: a key created and revoked, a secret stored, a reader
# key issued, an invitation answered, a durable branch created, a backup taken (by its new ID,
# removing the oldest first because the engine keeps three), and the sign-in form itself — 6 more.
cd ui && CHRONOGRAPH_SWEEP_ORIGIN=http://127.0.0.1:19090 \
  CHRONOGRAPH_SWEEP_EMAIL=operator@chronodb.local \
  CHRONOGRAPH_SWEEP_PASSWORD="$(cat /tmp/chronodb-local/owner-password)" \
  CHRONOGRAPH_SWEEP_STATE=/tmp/chronodb-local/sweep-session.json \
  node node_modules/@playwright/test/cli.js test e2e/console-actions.spec.ts \
  --project=desktop-chromium                                     # 5 passed

# engine.json is captured from a real engine, so refresh it when an operation's answer changes.
node scripts/capture-engine-shapes.mjs
python scripts/alerts-test.py                    # 14
```

If a row here claims something the commands do not show, the row is wrong and should be
fixed rather than believed.
