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
| Console sign-in, projects, team, secrets, audit | `ui/e2e/managed-auth.spec.ts`; control-plane suite 41 tests / 39 pass / 0 fail |
| Operator panel | allowlisted operator only; non-operators are told, not bounced |
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
cd launch/private/managed/control-plane && node --test test/*.test.mjs   # 41 tests
cd ui && node node_modules/@playwright/test/cli.js test --project=desktop-chromium   # 26
python scripts/alerts-test.py                    # 14
```

If a row here claims something the commands do not show, the row is wrong and should be
fixed rather than believed.
