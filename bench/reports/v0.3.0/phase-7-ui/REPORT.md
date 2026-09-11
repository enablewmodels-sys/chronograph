# Phase 7 — Community interface

Status: PASS. The light landing, generated terrain artwork, dark console, scoped
parent/fork selection, native SVG inspection, branch lifecycle, connectors and
20 linked guides are complete. No Managed/control/billing code was added.

Changed: `ui/src/{Landing,main,theme,workspace,GraphView,Explorer,Branches,Write,
Connectors,Documentation,api,shared}` and browser journeys. The exact production
source remains in the workspace; design concepts precede implementation in
`docs/design/v0.3.0/`. The five-point fidelity ledger is in `docs/DESIGN.md`.
No npm dependencies were added in this phase.

The whole-workspace gate passed, as recorded in results.json. The final UI uses
updated candidate benchmark numbers and labels the missed targets. The copied
e2e.json is the final release run: 16 expected, zero unexpected, zero skipped,
zero flaky; 91.649 seconds, four journeys × two viewports × two repetitions.

Actual final browser tail:

```text
✓ 15 [mobile-chromium] durable branches: write in isolation, inspect, preview, merge and reject stale alternatives
✓ 16 [mobile-chromium] landing artwork, documentation and connector navigation render at this viewport
16 passed (1.5m)
```

The first expanded run exposed mobile documentation overflow (14/16 passed).
Visual inspection also caught oversized nested SVG icons and mobile branch-table
width. These were fixed, viewport assertions added, and the final full run passed.
Internal tables now scroll without expanding the page. Clipboard text uses real
newlines, the SVG diagram loads, and every public chapter stays within viewport
bounds. Synthetic mode makes no graph calls. Raw browser traces remain private.

Connector controls link to real CLI/mapping workflows; they do not claim browser
hardware streaming. Branch lists are bounded to 1000 metadata rows and explain
API pagination. Graphs render 40 nodes/80 edges per page. Source checkout/publication
and Managed availability remain honestly labeled.

Resume: complete Community release hardening, native/source packaging and the
final report; stop before the agreed Phase 6 Managed review gate.
