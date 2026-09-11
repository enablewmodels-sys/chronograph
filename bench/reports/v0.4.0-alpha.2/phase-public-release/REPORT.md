# Community public-release verification

Version: 0.4.0-alpha.2. Date: 2026-09-11. Local platform: Apple Silicon macOS.
This release changes packaging, licensing, documentation and website behavior;
previous performance evidence retains its original version and timing conditions.

| Check | Result |
| --- | --- |
| Workspace build | PASS, locked dependencies |
| Workspace tests and doctests | PASS: 63 passed, 1 pre-existing ignored helper |
| Clippy, all targets, denied warnings | PASS |
| Rust formatting | PASS |
| Native console and public static website builds | PASS |
| Documentation links and mdBook | PASS: 25 chapters |
| Python durable-spool tests | PASS: 2 |
| Python wheel | PASS: new license expression, LICENSE and NOTICE bundled |
| RustSec | No vulnerability error; existing unmaintained paste warning |
| npm audit | 0 vulnerabilities |
| Public-source review | Allowlisted Community files; no runtime/config/private paths or credential-shaped bytes |

## Public website QA

The flow under test: landing → synthetic demo → explorer → exit → quickstart →
license → direct reload. Desktop 1536×1024 and mobile 390×844, two runs each.
All four runs passed. All 25 documentation routes also loaded directly.
Checks covered title/content, loaded hero image, viewport width, console errors,
synthetic status, absence of a token form and absence of real API requests.
The server applied the security headers and rewrites from vercel.json.

The Browser plugin/skill was not available; regular visible Chromium through the
Playwright skill was used at a disposable loopback port. Screenshots were visually
reviewed and kept outside the repository. Temporary servers were stopped.
Vercel deployment itself is performed by the repository owner and is not claimed
as tested here. Native-bundle smoke results accompany the release assets.

## Release boundaries

Community uses unmodified PolyForm Perimeter 1.0.0. Its noncompetition restriction
also covers free competing products. Third-party licenses are preserved.
This is source-available, not OSI open source. Public static hosting provides a
synthetic demo, not a persistent database. Managed infrastructure and billing are
not in this repository. Existing graph data and credentials were not changed.

## Clean checkout follow-up

The committed Vercel site installed and built successfully in a fresh temporary
checkout with no local state or build caches. The first Linux CI run found that
the broad runtime-journal exclusion omitted the 242-byte synthetic migration
fixture. The exact fixture path is now allowlisted, and source-archive verification
checks every literal Rust include_bytes!/include_str! input for existence. The
follow-up Linux CI run remains the source of truth for Linux verification.
