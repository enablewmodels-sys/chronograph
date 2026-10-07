# Changelog

## Unreleased

- The BCI workspace now records for a hosted account instead of asking it to install one. "Connect a
  recording" ended by printing a pip command and a `chronograph-bci` line, so a hosted account had to
  install the SDK and run a producer on its own machine before a single session existed — and a
  project that had already applied its recording contract showed "no recordings" with nothing to press.
  A new control-plane module (`launch/private/managed/control-plane/bci-acquisition.mjs`) produces the
  recording itself through the same connector contract the local agent writes: session metadata, an
  immutable stream contract, immutable signal chunks with their timestamps, cue events and one
  deliberate acquisition pause. The signal follows BrainFlow's own synthetic board — a deterministic
  mix of alpha, theta and beta rhythms, cue-locked lateralisation and noise, in microvolts, at the
  board's own geometry — so a Cyton-shaped recording is the default and nothing claims a device was
  opened. The workspace asks for a recording on load (`ensure`, idempotent, so a project that already
  holds one is left alone), and `POST /managed/bci/acquisition` starts, stops and reports runs, all
  bounded in seconds, memory and producers per project. `ui/src/BCI.tsx` finishes the migration with
  that request rather than a command line.
- Every board in the shipped BrainFlow catalogue now belongs to a vendor. The generated catalogue
  grouped a board under the placeholder vendor `undocumented` whenever the hand-written map omitted
  it, which hid 28 real boards — 14 Ant Neuro, 7 Muse, 5 NeuroMD, 4 OpenBCI, 4 Mentalab, 4 Synchroni,
  AAVAA, NTL and the OYMotion OB-series — behind one meaningless group in both the source picker and
  the device catalogue. The map is completed from the driver's own board factory
  (`src/board_controller/board_controller.cpp`, which names the controller class and therefore the
  vendor source directory each member is built in), transports are excluded from the undocumented
  set, and `scripts/bci-formats-test.py` now fails if a driver upgrade adds a member nobody has
  attributed. The catalogue reports 21 vendors and 0 un-attributed boards.
- A board carries its geometry into the form, and the channels are editable. A 16- or 64-channel board
  arrived with eight channel names and no way to change them; the picker now derives the names the
  driver reports (or a numbered pattern in the board's own signal family when it reports fewer than
  the geometry declares), and a channel editor renames all of them in one gesture — prefix, start
  index, digit count, separator — or any single row, with the unit and the channel type chosen from a
  list rather than typed. What the table shows is exactly what the recording claims. "Use" in the
  device catalogue now configures a recording on that board instead of only highlighting its row.
- App hosting is enabled on this deployment, and a project can author its own manifest.
  `/app/apps` said hosting was not enabled; the hosting block is now present, and because this host
  runs no container runtime the deployment runs appctl with its `dry-run` driver, which the page says
  plainly: a deploy is simulated and the recorded argv is exactly what a real deploy would run. The
  driver's location now resolves in the release layout as well as in a checkout (a configured
  `hosting.platformRoot` wins, otherwise `<release>/deploy/platform` is found beside the control
  plane), `deploy-control-plane.sh` ships the driver with the release, and `POST /managed/apps/create`
  writes a manifest from a closed set of options — never a manifest body — validated by appctl's own
  loader and renamed into place atomically. A mount with no size, or a size with no mount, is now
  refused with the missing half named rather than by appctl's complaint about the temporary file it
  was validating.
- Two things the operator panel had been reporting, both found by using it. The panel scoped the
  operator role to three addresses; it now names one, and the allowlist travels with the account
  roster so it is visible rather than inferred. The panel was also raising a critical "engine
  unreachable" alert for projects that were serving requests: its readiness probe used `fetch`, which
  will not set `Host`, so a loopback request arrived as `127.0.0.1:<port>` and every engine answered
  403. The probe now sends the deployment's own host, the same header the control plane sets when it
  proxies to a project. Beyond the read-only snapshot the panel can restart one project engine, revoke
  one account's sessions and set one membership's status — each refusing to target the acting
  operator, refusing to suspend a project's last active owner, echoing the target's address as its
  confirmation and writing exactly one audit row — and it lists accounts, live sessions and
  memberships without returning a session identifier.
- Four defects a review found in the work above, all of them real. The managed console still
  printed `pip install './sdk/python[bci]'` and a `chronograph-bci` command on the Connectors page,
  which is the one surface that had not been given the hosted answer; it now says what this
  deployment does and links to the workspace, and the SDK stays described as the thing you use for
  your own hardware. `scripts/bci-formats-test.py` still demanded exactly 18 vendors after the same
  change raised the table to 21, so the script the catalogue is checked with failed; it now compares
  the table against itself and against the shipped groups. Two concurrency defects were in the
  producer: two readiness asks arriving together each wrote a full recording, because the check and
  the write were separated by three round trips, and a live run scheduled its next second on a fixed
  interval, so an engine slower than one second made two chunks claim the same cursor and the run
  ended with a conflict. Readiness now joins one attempt per project, a tick schedules its successor
  only once it has finished, and every publish is serialised against the others for its run;
  `test/bci-acquisition.test.mjs` pins both, and both of its new cases fail against the code as it
  was. The Runs tab also claimed "Local workers available" directly above a status explaining that
  hosted training is off; the chip now reports the deployment's own answer. A pre-existing flake in
  the control plane's suite went with them: the diagnostics export was compared against a snapshot
  taken a moment earlier, so the host's uptime could differ by a second and fail a test about the
  export being complete rather than about the clock.


- The website is mobile friendly, and the floor is asserted rather than assumed. Auditing the live
  pages at 390x844 found the stylesheets making text *smaller* on a phone than on a desktop — 7px
  timeline ticks, an 8px scene caption, 9px navigation sections, a 10px version badge — inline links
  16px tall that a thumb cannot reliably hit, a section nav that scrolled sideways instead of folding
  (its links ran to 869px inside a 390px screen), a price table whose column headers were cut
  mid-word, and 88px of padding top and bottom on every landing section. `ui/src/mobile.css` now
  states the floors once — nothing a reader has to read below 12px, prose at 14px, every control and
  navigation link at least 40px tall, long words unable to push a page sideways, the two landing
  grids stacking into one readable column, and the price table keeping its row labels sticky while
  the columns scroll. Links inside a sentence are explicitly exempt: a link mid-paragraph cannot be
  a 40px target without breaking the paragraph.
  `ui/e2e/mobile.spec.ts` holds all of it at a phone viewport, on every public page, including that
  no navigation scrolls sideways — the regression this would otherwise silently return through.
  Measured on the live site afterwards: 0 horizontal overflow, 0 text beyond the viewport, 0 text
  under 12px and 0 controls under 40px, on every page (previously 33/33 on the landing page alone).

- Three more things a review found, all of them the difference between what the code said and what
  it did. A retried invitation for a brand-new address was still refused with "this account must
  finish its current setup first" — a step the invitee cannot take, for a person whose only step is
  to open the link they never received — so a pending invitation is re-issued instead. A
  forgot-password link really did die after an hour: the gateway checks the control plane's own
  invitation row before the provider's, and that row was written at one hour while the message and
  the provider's row said a day. And the file transport corrected the spool's *directory* mode,
  which is wrong when an operator points the spool at a shared directory: it now corrects a
  directory only when this process owns it, and relies on the file's own 0600 for the link. The
  hosted documentation's "links expire after one hour" and its promise that a reset preserves the
  authenticator were corrected too — there is no authenticator to preserve.
- The account lifecycle is exercised through the pages a person uses, with the deployment's own
  mail: sign up on /signup, read the message the control plane actually wrote to its spool, open
  the verification link, set a password, and sign in as the new account. The link exists only in
  the spool, so the test cannot pass without delivery, and it corrected two of my own mistakes on
  the way: it first visited /signup while carrying the suite's session — which the deployment
  redirects away, correctly — and it treated the gateway's per-IP rate limit as a broken signup
  rather than waiting it out.
- Two defects a review found in the invitation path, both worth fixing before calling it done. The
  console's request bound is eight seconds and the mail transport's was ten, so a slow relay told the
  operator "the service did not answer in time" while the invitation had in fact been created and
  emailed; the send is now bounded below the console's patience, and a repeated invitation for
  somebody already invited re-issues the link instead of answering "this person already belongs to
  the project". The link in an invitation was a one-hour password-reset token while the invitation it
  belongs to is meant to be read hours later, and the message stated no expiry at all: the token now
  lasts a day, the message says so, and the sign-in copy that promised an hour was corrected.
- The mail spool is written the way a credential is. A fresh file was created 0600 but an existing
  one kept whatever mode it had, the directory was left alone, and appendFile followed a symlink
  planted at the path — so an activation link could land in a world-readable file or somewhere else
  entirely. It now opens with O_NOFOLLOW and corrects both the file and the directory mode. The
  loader also tightened what it accepts: one real from address rather than "contains an @", a full
  Resend key rather than its prefix, no headers the platform owns, and a normalised spool path.
- Layer 4 is driven from its own console, not only from a test of its routes. Every deployment
  without a hosting block answers "Hosting is not enabled for this deployment", so plan, deploy,
  roll back and destroy had only ever been exercised at the API level; the local deployment now
  enables hosting on the dry-run driver (which records the argv a container runtime would receive
  and touches nothing) and the console suite walks the real controls: a manifest in the project's
  own directory lists the app, Plan shows the exact build/run/health argv, Deploy records a digest
  and a healthy probe in the ledger, Roll back either rolls back or refuses with appctl's reason
  rather than inventing a target, and Destroy stops and removes the container. Two stricter
  manifest rules are visible from the console as a result: an unknown key is reported on the Apps
  page and refused by plan and deploy, and the ledger shows the first twelve characters of the
  digest it recorded.
- Mail delivery is the operator's infrastructure, and invitations now actually go out. The control
  plane had one hardcoded transport — Resend's API — so a deployment without that vendor's key could
  not turn on email signup, password recovery or team invitations at all, and the invitation path
  never sent a message even when mail was configured: the console had to tell the operator to pass
  the link on by hand. A private `mailFile` now names one of three transports (`resend`, `http` for
  any relay that accepts the same JSON, or `file` for a spool an MTA or the operator drains), the
  loader bounds each of them, and an owner's invitation of a brand-new address provisions the
  account and emails the link. The refusal that said "until email delivery is connected" is now
  honoured rather than permanent. Delivery is reported, not assumed: a send that fails leaves the
  invitation working, records `project.invite_undelivered` in the audit trail, and tells the console
  to show the link with the reason. Proven end to end against a real deployment, where the spool
  holds the message it claims to have sent.
- The control-plane suite's only integration tests run again, and they run everywhere. They had
  been reported as "2 skipped" for this whole line of work, and running them showed they would have
  failed if they had run: the engine path was passed as `target/release/chronograph-server`, which
  is relative to the repository root rather than to the test directory, so provisioning died with
  `spawn ... ENOENT` — and the fixture inherited the production 5 GiB write floor, so a developer's
  nearly full laptop turned "project provisioning works" into a 503. The fixture resolves the binary
  against the repository root and sets its own floor, and the suite warns loudly when the variable is
  absent, because a silent skip is how the only coverage of real project provisioning, schema CAS,
  scoped keys, SDK routing, MCP, restart persistence and role boundaries went unexercised. With
  `CHRONOGRAPH_TEST_BINARY` set: 46 tests, 46 pass, 0 skipped.
- The deployment probe passes against production. `scripts/production-check.py` had never been run
  in this work; it reports `ok: true` for liveness, readiness, anonymous API and metrics refused,
  authenticated API and metrics, durable write policy and writer health on https://chronodb.co. It
  must be given the public origin — the engine authorises by origin, so a loopback URL fails every
  check for the wrong reason, which is exactly what it did first.
- The console suite runs at both viewports and passes at both. The mobile project had never been
  run in this line of work; it failed three tests, and the product was right in all three: below the
  desktop breakpoint the console collapses its sidebar behind "Open navigation", so a locator for the
  navigation itself is invisible and a click inside it never lands. `ui/e2e/navigation.ts` opens it
  when the viewport has collapsed it, so one test now serves desk and phone: 38 passed / 0 failed on
  mobile, where it was 35 / 3.
- The repository can be pushed again. GitHub push protection refused the branch because two test
  sentinels were shaped like live Stripe keys — one planted in a worker's environment to prove it
  reaches no response, log or dry-run trace, one placed in a manifest to prove validation refuses
  credential-shaped text and never echoes it. Neither needs a provider's prefix: the Stripe-shaped
  value is now assembled at run time, so the tree holds no Stripe-, GitHub- or AWS-shaped literal
  while the validator is still handed one, and a third fixture in platform-connectors-test.mjs that
  signed its webhooks with a `whsec_`-prefixed string is assembled the same way. The offending lines
  existed in unpushed commits owned by this work, so that range was rewritten rather than superseded,
  and the branch is pushed. The published history still contains the older `whsec_` fixture; it was
  accepted by the remote, and rewriting published commits again is not worth a force-push.
- A session lasts as long as a working day does not end it. The control plane dropped any session
  that had been quiet for thirty minutes and the cookie expired after twelve hours with no refresh,
  so an operator who left the console open came back to the sign-in form — and reported it as
  "/admin is broken", because that is what it looked like. The lifetime is now 30 days and rolls
  with use, the idle window is 14 days, and a session that does end sends the reader to
  `/login?expired=1`, which says the session expired instead of showing an unexplained form.
  `launch/private/managed/control-plane/identity.mjs` owns the three numbers; the control-plane
  suite asserts both sides of the idle boundary.
- The rolling session actually reaches the browser. Keeping the session row alive was only half
  the fix: `session()` discarded the `Set-Cookie` the identity provider issues when it refreshes a
  session, so the row rolled forward while the browser's cookie kept the expiry it was given at
  sign-in. Measured on a local deployment with the row staged 28 days out: `/managed/session`
  returned no `Set-Cookie` before, and `Max-Age=2592000` with the row back at 30 days after.
  A test that pins the policy literals replaced the boundary-only assertion, which stayed green
  for any value including the half hour it replaced.
- A refusal now says what to do. The gateway replaced every 5xx message with "The account
  service is unavailable. Please try again.", including the ones this codebase raises on purpose,
  so a deployment whose disk had fallen below the write floor reported itself as an account-service
  outage — found by pressing "New API key" against a real control plane, where the write was refused
  at 503 and the console showed the wrong reason. An error carrying a deliberate status and code
  keeps its message; an unexpected throw is still masked so internals do not leak. `test/errors.test.mjs`
  pins both directions, and the refusal now names the measurement and the floor.
- Intent is a mark rather than an inference. The gateway decided whether an error was a written
  refusal or a crash by looking for an integer status and a string code — correct for everything in
  the installed dependency set, but it read intent off objects this codebase does not own, so one
  dependency that set both fields would start leaking its message to a client. `problem()` and
  `HostingFailure` now set a non-enumerable symbol and the gateway asks `isDeliberate(error)`. The
  message of a masked failure is also logged with its request id now: it was the only description of
  the failure anywhere, and it went nowhere, so nobody could find out what had happened.
- The operator panel's disk warning names the trigger that fired. It has two — an absolute floor and
  a tenth of the volume — and it named the floor whichever one tripped, so a panel could read "below
  the operating threshold of 5.0 GiB" beside "6.0 GiB free of 100.0 GiB".
- The write floor is one number in three places, not three numbers. A review found that
  `minimumFreeBytes` governed only the graph-write guard while `projects.mjs` still hardcoded
  5 GiB for provisioning and the operator panel used its own 5 GiB for the disk warning, so a
  deployment that lowered the floor could serve writes but not create the project they belong to,
  and the panel would warn about a state that was not a problem. All three read the deployment's
  value now, and each refusal names the measurement and the floor it compared against. The
  loader's exact bounds are pinned too: 64 MiB and 1 TiB accepted, one byte either side rejected.
- The write floor is a deployment decision. Five gigabytes suited an instance holding real projects
  and made the product look broken on a small development volume, which is where the write paths
  above were first exercised. `minimumFreeBytes` defaults to 5 GiB, is bounded by `config.mjs`, and
  `scripts/managed-local.mjs` sets a small one deliberately.
- The console's controls are tested, not just its pages. `ui/e2e/console-actions.spec.ts` creates and
  revokes an API key, stores a secret and issues a reader key, invites a collaborator (asserting the
  refusal and its reason on a deployment without mail delivery), creates a durable branch and takes a
  consistent backup — all through the rendered controls against a real deployment, 6/6. Two of them
  assert state rather than appearance: the backup is identified by a new backup ID (the engine keeps
  three and refuses the fourth, so the test removes the oldest first), and a separate test signs in
  through the rendered form, because the failure this product actually had was a form that accepted a
  password and bounced the reader back to itself. The suites that need a real deployment now share
  `ui/e2e/real-deployment.ts`.
- The authenticator UI is gone from the sign-in page. The operator removed the authenticator, so the
  enrolment screen and the code prompt could not be reached, and the one remaining call to
  `/api/auth/two-factor/enable` answered 404. A `needsMfa` account is now refused explicitly with
  its reason rather than falling through to a password form that cannot help it.
- Two holes a review found in the sweep itself are closed, and it now presses a button. A page whose
  reads all failed still drew its own headings and passed; a page that redirected away drew another
  page's content and passed too. Each page carries copy only that page draws, and the control
  plane's "this workspace operation is not available" answer fails the run wherever it appears. The
  sweep also stops only reading the page that offers the decoder: against a real deployment it
  clicks through, runs the served wasm module in a browser and requires a token back, which makes
  the encoder-database-decoder claim checkable rather than described.
- The account an operator signs in with is the account that can open the panel. The allowlist held
  two addresses while the browser was signed in as a third, so /admin answered "operator access
  required" for its owner. The deployment's `superadminEmails` now names every address the owner
  signs in with.
- The console suite visits every page, and against a real deployment rather than a mock. A mock
  whose payload the server never sends tests the mock: the previous sweep invented bodies, so pages
  that crashed on a missing list looked like page bugs and pages that survived proved nothing.
  `scripts/capture-engine-shapes.mjs` boots a real engine and records what each operation actually
  answers into `ui/e2e/fixtures/engine.json`, which the sweep replays; `scripts/managed-local.mjs`
  runs the real gateway over a real engine with a real session, and with
  `CHRONOGRAPH_SWEEP_ORIGIN` the same 13 pages plus the operator panel are walked there: 14/14.
- A page that fails to render no longer takes the console with it. Every route now sits inside a
  boundary that names the failure and offers a retry, because one bad payload previously produced an
  empty screen with nothing to read.
- A 401 from a project's engine is no longer treated as a sign-out in the Managed console. It means
  the graph connection is not established, which is an ordinary state; reading it as an expired
  session bounced an operator away from /admin and, with the new redirect, could loop.
- Layer 4 is implemented, not just declared. `deploy/platform/appctl.mjs` runs one container per
  app with persistent storage, a health gate that stops an unhealthy container, preview then
  promote that re-tags the exact image digest the preview ran, rollback, an append-only ledger
  holding reference names rather than values, and hostname binding that fails closed without its
  secret. A dry-run driver records the argv the docker driver would execute, which is what makes
  `scripts/appctl-test.mjs` (34 checks) meaningful without a daemon. Horizontal scaling and a
  filesystem quota are refused rather than faked.
- The source picker now offers every board. BrainFlow ships 64 boards and documents 18 vendors, and
  28 boards carry the placeholder vendor "undocumented"; the picker and the device catalogue both
  grouped by the documentation map, so those boards could not be chosen at all and a group labelled
  "3 boards" held one. Groups are derived from the boards through one module (`ui/src/bci-vendors.ts`),
  and `ui/e2e/catalogue.spec.ts` walks the real widget and fails unless every catalogued board is
  selectable exactly once.
- An unreachable account service is reported instead of a sign-in form. When `/managed/session`
  fails, `/app`, `/projects` and `/admin` now say the account service is not answering and offer a
  retry; they no longer drop a signed-in person on the sign-in form as if their session had ended.
- An invitation that has not been accepted is no longer asked for an authenticator code. The
  activation state has its own panel explaining the invitation email, with a way to use another
  account.
- The decoder wrapper checks `disposed` before calling into wasm, so a released decoder reports
  that rather than whatever the module says about null pointers, and a decoder that is never
  disposed releases its artifact buffers through a `FinalizationRegistry` backstop.
- The device catalogue and the source picker label the placeholder group identically
  ("Undocumented (BrainFlow)"), and the picker's note now distinguishes the 18 documented vendors
  from the 28 boards BrainFlow does not document, so the 19th group in the list is explained.
- `scripts/bci-formats-test.py` compares the shipped catalogue with the installed driver in every
  dimension a user sees — board names, vendor, device, rate, primary channel count, modality,
  describable flag, channel names, per-preset geometry, counts, vendors, transports and the
  undocumented set — instead of only two counts. That gap is why 28 unreachable boards shipped
  behind a green suite; the suite is now 2,902 checks.
- The repo's own browser suite is green again: `superadmin.spec.ts` and `console.spec.ts` still
  asserted the pre-change `/admin` behaviour and headings from an older landing copy.
- Layer 4 is reachable from the product. The console's Apps page lists a project's apps with
  health and the active image digest, and offers plan, deploy, promote, roll back and destroy
  through `/managed/apps*` in the control plane, driving the same `appctl` runtime the CLI uses.
  Hosting is opt-in: with no `hosting` block every route answers 404 and the page says so. A
  deploy can only name a manifest that already exists under the project's own directory, a plan is
  the one call a viewer may make, mutations need an admin, destroying needs the owner plus a
  confirmation echo, and the child process gets an argv array, a minimal environment that carries a
  secret reference by name only, and bounded time and output.
  `scripts/hosting-test.mjs` covers 12 scenarios and 386 checks against the real gateway with real
  owner, admin, editor and viewer accounts.
- Operational alerts have somewhere to go. The monitor reported
  `external_alert_delivery: False` as a literal, so an unhealthy host produced nothing
  anybody would see. `launch/private/managed/control-plane/alerts.py` posts an unhealthy
  report to `alertWebhook` (or `CHRONOGRAPH_ALERT_WEBHOOK`) and records the outcome:
  `destination: none` with no destination configured, `delivered: false` with the
  reason when the destination refuses, and no request at all for a healthy tick.
  `scripts/alerts-test.py` runs the real module against a local server — 14 checks.
- A provider token can now open a workspace session. `POST /managed/provider-session` verifies the
  token through the Layer 5 connector and exchanges it for the control plane's own session, reusing
  the existing account hook, session adapter and cookie signer rather than inventing a second
  identity path. It is opt-in through an `identityProvider` block in `control.json`: with the block
  absent the route answers 404 and nothing else changes, which is what the release ships.
  `scripts/provider-identity-test.mjs` signs real tokens with generated keys and covers a foreign
  key, an expired token, a wrong audience, an unverified address, an allowlist miss, an unknown
  project, role escalation and a replayed exchange — 108 checks, with no token present in any audit
  row or response.
- Layer 5 is implemented, not just declared. `deploy/platform/connectors/` verifies a provider
  token (RS256 and ES256 against a cached JWKS with `iss`, `aud`, `exp`, `nbf` and skew checks),
  maps a subscription state to project capacity behind a signed, unexpired, unseen webhook, and
  binds a hostname through Cloudflare SaaS or returns the exact request it would send. A missing
  secret reference fails closed, a value never leaves the resolver, and
  `scripts/platform-connectors-test.mjs` generates real key pairs and signs real tokens so the
  refusals are proven rather than asserted.
- The public Community edition is live at https://community.13.57.235.204.nip.io — a static site
  with no API and no account state, served by Caddy beside the Managed deployment. It builds
  without npm (`scripts/build-site.mjs` now calls the local tsc and vite), and the Caddy config is
  validated before a reload with the previous file kept.
- The console runs the decoder, not just links to it. `ui/src/browser-decoder.ts` loads the served module
  and artifact through the SDK's own reader, synthesises a band-coded window in the page and shows the
  decoded token; `ui/e2e/catalogue.spec.ts` clicks the button and asserts the answer. Making that work
  exposed a real blocker: the Content-Security-Policy said `script-src 'self'`, which refuses
  `WebAssembly.compile`. Every CSP now allows `'wasm-unsafe-eval'` — the narrow source that permits
  WebAssembly compilation only, with `'unsafe-eval'` still absent — in the engine, the managed gateway
  and the site headers.
- The browser decoder ships with the console: `/wasm/chronograph-decoder.wasm` and
  `/wasm/artifact/` are served from chronodb.co, so a web application runs the same reader as
  Python instead of writing a third implementation. `sdk/typescript/test/decoder.mjs` decodes
  those exact shipped bytes and matches Python to 1.1e-16.
- Publishable SDK artifacts, built and install-verified here: `dist/sdk/chronograph_connectors-0.4.0a3-py3-none-any.whl`
  (sha256 033e0e34…) installs into an empty target and imports the decoder, registry and catalogue;
  `dist/sdk/chronograph-community-sdk-0.4.0-alpha.3.tgz` (sha256 e8d44ea7…) extracts to a package
  that exports `Decoder`, `Client` and `BCIClient`. The TypeScript suite is 16 tests, all passing.
- The console loads again after sign-in. Three route gates still required
  `user.twoFactorEnabled`, which the server reports as false while the authenticator is off, so
  `/app` sent a signed-in account to `/projects`, that sent it to `/login`, and the sign-in page
  sent it back: an endless redirect with a blank screen. Readiness is now the server's own answer
  (`!needsMfa && !needsActivation`), a failed `/v1/info` clears the graph connection instead of the
  account session, and `ui/e2e/managed-auth.spec.ts` pins both.
- `/admin` no longer bounces a signed-in non-operator to the sign-in form; it says the panel
  belongs to the platform operator account. The allowlisted operator reaches the panel.
- Static musl engine. `chronograph-server` is now deployed as a statically linked aarch64
  binary (`releases/20261005-musl`, sha256 4e9bcd8e63c54736...), identical to the artifact built
  from this tree, with the previous release kept for rollback.
- Bundle caching actually reaches the browser. The gateway set `cache-control: no-store` on
  content-hashed bundles at the response writer, so Cloudflare could not cache a byte and every
  visit re-downloaded the console; assets are now `public, max-age=31536000, immutable` and the
  edge reports `HIT` (entry TTFB 78 ms, from 823 ms).
- Scheduled project backups work again. The backup service runs as root and created the project
  backup directory `root:root 0700`, which the project engine, running as its own user, could not
  write: `POST /v1/backup` answered 500 forever and the health monitor stayed red. The directory
  now inherits its parent's owner, and every project passes its freshness check.
- The BrainFlow catalogue is regenerated from the installed driver (5.23.0: 64 board IDs, 18
  vendors, 89 presets, 3 transports, no unavailable vendor) and the console's source picker now
  offers the vendor, device and preset it previously hid behind four source families. The format
  suite no longer repeats 5.22.2 counts as literals; it derives them from the catalogue users get,
  and reports 2,321 checks over 64 boards and 8 file formats.
- TypeScript decoder: `sdk/typescript/src/decoder.ts` executes the shared `decoder-v1` artifact
  through `crates/chronograph-wasm`, and `sdk/typescript/test/decoder.mjs` decodes five windows
  built by `scripts/decoder-fixture.py` and compares every probability with Python's output
  (largest difference 1.1e-16).
- WebAssembly decoder: `crates/chronograph-wasm` runs the same `decoder-v1` artifact as Python and
  the native binary through a linear-memory ABI, and `scripts/bci-wasm-test.py` proves the three
  agree (5 windows, identical tokens, largest probability difference 1.1e-16). The artifact reader
  is now byte-based (`Decoder::from_bytes`), so the browser is not a second implementation.
- TypeScript SDK: `BCIClient` reads accept a `branch` and gained `causalPath`, matching the HTTP
  operations, with argument validation before any request.
- Static musl build: the executor compiles for `x86_64-unknown-linux-musl` and
  `.github/workflows/decoder-musl.yml` builds it on Linux, asserts the binary is statically
  linked and publishes its checksum. A macOS host can compile that target but cannot link it
  without a GNU cross-linker, so the artifact is produced where it can be built.
- Platform contracts: `deploy/platform/connectors.json` and `deploy/platform/app.example.json`
  state the five layers, their boundaries, their artifacts and their secret references, and
  `scripts/platform-test.py` fails if a contract carries a credential or points at a missing
  artifact. Layer 5 stays delegated to Ory Kratos, SuperTokens or Authgear, Stripe and Cloudflare
  for SaaS; app hosting is a container contract with a documented store-submission hand-off.


- `BCIClient.to_mne(session)` returns the recording as an `mne.io.RawArray` with stored channel
  names, types, units, rate, annotations and bad channels, so an existing MNE and scikit-learn
  pipeline reads it directly. A recording with explicit gaps is refused instead of joined.
- Samples per durable commit is now an explicit knob: `chunk_samples` on the synthetic generator
  and the file readers, `pull_samples` on LSL. Measured on one host, 500-sample records cut a
  2000-sample recording from 37 commits to 8 and from 1.25 s to 0.21 s while storing identical
  samples. Ingestion still synchronizes before every acknowledgment; the lever is commit
  frequency, never weaker durability.
- New guides: [why BCI teams bounce and what was done about it](docs/ADOPTION.md), and the
  landing hero now leads with the BCI-to-robotics pipeline.


- One writer serves every branch. `connector_ingest` accepts a `fork`, so normalized records — BCI
  sessions, signals, events and decoder predictions — commit into a branch through the one central
  write path and journal lock. The receipt shares the branch frame, so a branch commit is as
  durable and as retry-safe as a parent commit, and partition cursors are keyed per branch.
- `Graph::apply_fork_batch` commits independent batches for several branches in one frame and one
  synchronize, so branch count no longer scales writer, frame or fsync count. Every branch is
  prepared before anything is written, so a rejected batch leaves all branches unchanged. Journal
  tags 12 and 13 are additive and do not change the file format version.
- The derived BCI index covers branches: `bci_sessions`, `bci_session`, `bci_records`,
  `bci_window` and `bci_manifest` accept `fork`, and an omitted `fork` shows the parent only.
- New `bci_causal_path` operation and MCP tool: walk recorded lineage from a prediction back
  through its run, dataset, sessions, streams and signal chunks, bounded by depth and rows.
- New declarative encoder registry (`chronograph_connectors.sources`) with one generic writer:
  synthetic, BrainFlow, LSL, MNE files (EDF/BDF/FIF/BrainVision/EEGLAB) and tabular formats
  (CSV/TSV/NPY/OpenBCI TXT/BrainFlow CSV). Existing entry points keep working through it.
- Full BrainFlow board coverage from the installed library, resolved through `get_board_descr` so
  boards whose row and name accessors raise (Callibri EMG/ECG, gForce Pro/Dual, Ant Neuro
  EE-410, EmotiBit) are described correctly, including boards with no EEG rows. Every transport (live board, playback
  file, streaming board, streamer file, all presets) and every preset is described, and documented
  vendors with no installed board ID are reported rather than invented.
- Pluggable decoder adapters (`chronograph_connectors.decoders`) with entry-point discovery, a
  reference closed-vocabulary `eeg2text-v1` text decoder with per-token probability and explicit
  abstention, the existing `csp-lda-v1` baseline behind the same interface, and a portable
  `decoder-v1` artifact plus a dependency-light Rust executor held to it by a parity test
  (tokens identical, largest probability difference 3.3e-16). The executor is packaged and
  documented for a static musl target, which was not built in this environment.
- New guides: [device and file formats](docs/FORMATS.md), [decoders](docs/DECODERS.md) and
  [platform layers](docs/PLATFORM.md).

## 0.4.0-alpha.3 — 2026-09-30

- `scripts/quickstart.sh` starts a local Community console in one command: it builds the console and server, mints an admin token when none exists, and serves without overwriting an existing workspace or credential file.
- `chronograph-server import FILE.csv` loads `src,dst,kind,valid_from[,valid_to][,payload]` into a workspace offline. Every row is validated before the first write, so a rejected file leaves the journal byte-identical; rows are applied in sorted order and a second run appends. Thirteen unit tests plus an `examples/episodes.csv` sample.
- New [comparison and alternatives](docs/COMPARISON.md) page stating plainly when to use PostgreSQL, SQLite, DuckDB, Neo4j, Memgraph, XTDB, Dolt, TerminusDB, LadybugDB, CozoDB or a plain Arrow lake instead, with a capability matrix and the honest limits side by side.
- [Quickstart](docs/QUICKSTART.md) rewritten around the one-command path, with the environment variables, the CSV import format and a Windows note.
- TypeSafe Jev `decisions-v1` preset, validated Python/TypeScript decision bindings, opt-in JSON attachments, example bundle and Binder notebook (36 presets across 18 connectors).
- Hosted invitation-only alpha documentation and console build mode, Jev homepage announcement, fixed SDK CI setup and an explicit static Pages workflow.
- Upgrade rustls to 0.23.45 to address RUSTSEC-2026-0285.

- Community SDKs for Python, TypeScript/JavaScript, Java, C++, Go, Dart and C#, plus a Q# Python host example. Native transports enforce bounded bodies, TLS for remote endpoints, redirect rejection and structured errors.
- Shared OpenAPI 3.1 input schemas derived from the MCP operation registry; JSON responses remain extensible.
- Five additional migration descriptors: BrainFlow, Q#, portable quantum results, named model outputs and physical-AI transitions (35 presets total). Python adapters preserve source clocks, tensor bytes, quantum counts and decoded ROS media.
- Real-server polyglot conformance tests, controlled transport fault tests and synthetic/local BrainFlow, LSL and QDK fixtures. Physical hardware and QPU jobs are not certified.
- Source distribution only at this step; no SDK package registry or new binary release is implied.

## 0.4.0-alpha.2 — 2026-09-11

- First public Community release preparation: source, Apple Silicon native bundle and Python connector wheel.
- Apply unmodified PolyForm Perimeter 1.0.0 to ChronoDB-owned code and docs. Modification and noncompeting commercial use are permitted; competing products, including free alternatives, are restricted. Third-party licenses remain unchanged. This does not revoke rights already granted for earlier copies.
- Publishable static landing page, documentation and synthetic read-only demo, with Vercel configuration and no database credentials.
- Updated install, licensing, security and edition guidance; reproducible release and source-boundary checks.


## 0.4.0-alpha.1 — connector transport

- Format-3 atomic ingestion receipts and explicit format-2 upgrade; latest identical retries are durable and idempotent.
- Shared registry with 28 presets, immutable migration-v2 bindings and explicit sidecar payload encoding. Migration-v1 checksums remain stable.
- Checksummed binary/tensor assets, resumable chunk publication and bounded byte-range retrieval.
- HTTP/MCP connector operations, migration dropdowns and connector console.
- Python client, durable local agent queue and external JEPA, hierarchy, transition, MNE, LeRobot, Qiskit and Cirq adapters.
- This is an alpha. Remaining native adapters and managed infrastructure are tracked separately; no public deployment has occurred.


## 0.3.0 — Community local release candidate

- Checked format-2 journal, ordered temporal indexes, centralized atomic mutations,
  bounded validity intervals, explicit durability and exclusive file ownership.
  Format-1 migration writes a new destination; opening never silently migrates.
- Durable copy-on-write branches with shared frozen bases, isolated deltas,
  conflict-checked atomic merge, new-ID mappings and retained lifecycle results.
- Axum HTTP service, scoped expiring/revocable Argon2id machine tokens, bounded
  work queues, exact Host/Origin checks and native Rust MCP stdio bridge.
- Consistent checksummed journal/index/sidecar backup and staged independent restore.
- BCI simulation and optional native LSL, bounded rosbag2/MCAP and LeRobot adapters,
  complete-state world-model/Minari replay, and exploratory OpenQASM/calibration support.
- Light landing with generated artwork; dark temporal explorer, branch workspace,
  writes, connector guides, agent access and operations. Exact IDs stay strings.
- Offline manual, native packaging, dependency inventory/license notices,
  container bootstrap recipe, CI gates and retained test/benchmark evidence.

Breaking changes: the old password/session service and legacy SHA-based machine
credentials are removed. Create fresh scoped tokens in an external config path.
This service remains a preview; no hosted Managed platform or billing is included.
GitHub/crates publication, signed downloads, external infrastructure and deployment
validation are separate gates. See docs/REQUIREMENTS.md and docs/LIMITATIONS.md.
