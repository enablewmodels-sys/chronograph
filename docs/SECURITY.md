# Community security model

Community is a single-workspace service with workspace-wide bearer scopes. The
current service is a preview, not an audited production security boundary.
Managed accounts, OAuth, teams and billing belong in the separate control plane.

## Credentials

`cg_<16 hex ID>_<64 hex random secret>` carries 256 random secret bits. The external
`config/auth.json` stores Argon2id hashes with independent random salts: version
19, 19 MiB memory, two iterations, parallelism one. Unknown hash parameters,
legacy credential versions, duplicate token IDs and malformed scopes fail closed.
Credential files must be regular mode-0600 files; the config directory is private.
A stable advisory lock prevents the server and offline CLI from editing auth at
once. Updates use same-directory rename and file/directory synchronization. An
ambiguous persistence failure disables authentication until the store is reopened.

Token ID lookup avoids scanning expensive hashes. At most two Argon2 jobs run
at once. A verified token's SHA-256 digest is cached **only in process memory**;
this is not the persistent credential format. Every request checks the active
record and expiry first. Revocation commits before acknowledgement, clears caches
and invalidates subsequent requests from established MCP clients. Already
admitted work can finish. Limits: 120 uncached/invalid verifications per rolling
minute and 12,000 requests per token per minute. Global failures can temporarily
throttle a new legitimate client; keep the preview behind an appropriate network
boundary when testing remotely.

Read can inspect the whole graph. Ingest adds writes. Admin adds token management,
backups and demo loading. There is no row-level filtering. Token creation reveals
the raw secret once. Keep operator token files outside source control. The console
retains its token in JavaScript memory, never URL parameters, cookies, localStorage
or sessionStorage. Reload disconnects it. Browser extensions and injected scripts
can read memory; protect the origin and the local machine.

There are **no sessions or CSRF tokens**: browsers do not automatically attach an
auth cookie, and the API requires an explicit bearer header. Origin validation
also rejects cross-origin calls; CORS is disabled. Legacy passwords/SHA token
hashes cannot be converted into new secrets. Rotate into a separate v2 auth store.

## Network and process boundaries

Exact Host and optional Origin checks apply to every request, including health.
Forwarded host headers are ignored. Remote configured origins require HTTPS.
The native bridge also rejects remote plaintext and redirects. The documented
Caddy deployment terminates TLS; its deployed behavior is still PENDING.

Headers include restrictive CSP, no-store, nosniff, DENY framing, no-referrer,
disabled camera/microphone/geolocation, and HSTS for HTTPS origins. UI Markdown
never enables raw HTML. Input/output limits and the 8-worker/32-waiter admission
queue bound service work. HTTP request bodies are limited while streaming.

Logs omit bearer values and request bodies. Internal errors can contain local
paths. The journal records mutations, not authenticated actor identities; there
is no actor audit trail yet. Do not enable credential logging at the proxy.

## Files, backup and recovery

One owning process holds an OS-level journal lock. The service's local account
and data-directory owner are trusted. Do not share writable volumes with untrusted
processes. The graph and sidecars are not encrypted by the engine; apply volume
encryption and encrypted off-host backups where needed.

Archives contain only the synchronized journal, a disposable index snapshot and
owned regular sidecar files. Auth is excluded. Restore rejects traversal paths,
symlinks, duplicate/unlisted/missing files, oversized archives and checksum errors.
It validates a staging copy by journal replay, then renames into an empty destination.
Checksums detect corruption; they do not authenticate an archive from an untrusted
party. Choose trusted backups and retain their binary/format version.

Never retry an uncertain write blindly. After disk failure inspect capacity and
permissions, stop the owner, preserve files and reopen. Failed or partial appends
are covered by engine recovery tests, not by an availability guarantee. The tests
are not medical certification or evidence that a control loop is safety certified.
