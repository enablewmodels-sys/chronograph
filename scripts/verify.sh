#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export CHRONOGRAPH_REPORT_PHASE=phase-local-final
export PROPTEST_RNG_SEED=4848215499434033153
python3 scripts/check-phase.py "$CHRONOGRAPH_REPORT_PHASE"
cargo test --locked --workspace --all-features -- --test-threads=2
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo audit
npm --prefix ui ci
npm --prefix ui run format:check
npm --prefix ui audit --audit-level=high
npm --prefix ui run build
mdbook build
RUSTDOCFLAGS='-D warnings' cargo doc --locked --workspace --no-deps
cargo build --locked --release -p chronograph-server --bins
node scripts/protocol-test.mjs
(cd ui && npx playwright install chromium && npm run test:e2e -- --headed)
node scripts/service-latency.mjs
# Full 10M benchmark: python3 scripts/release/bench-final.py (new dataset only).
# Optional container gate: docker build -t chronograph:ci .
# python3 scripts/container-smoke.py --image chronograph:ci
