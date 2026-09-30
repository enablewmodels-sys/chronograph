#!/usr/bin/env bash
# ChronoDB Community — one-command local start.
#
# From a source checkout this builds the browser console and the server, creates
# an admin token if you do not have one, and serves the console on
# http://127.0.0.1:8080. It does not download anything except the npm and cargo
# dependencies the build declares, and it never overwrites an existing workspace
# or credential file.
#
# Usage:   ./scripts/quickstart.sh
#
# Environment (all optional):
#   CHRONOGRAPH_BIND         listen address        (default 127.0.0.1:8080)
#   CHRONOGRAPH_DATA         workspace directory   (default ./community-data)
#   CHRONOGRAPH_AUTH         credential file       (default ./config/auth.json)
#   CHRONOGRAPH_TOKEN_FILE   where to write a new token (default ./config/admin.token)
#   SKIP_BUILD=1             reuse existing build output
#
# Stop the service with Ctrl+C. Config is kept outside graph data.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BIND="${CHRONOGRAPH_BIND:-127.0.0.1:8080}"
DATA="${CHRONOGRAPH_DATA:-$ROOT/community-data}"
AUTH="${CHRONOGRAPH_AUTH:-$ROOT/config/auth.json}"
TOKEN_FILE="${CHRONOGRAPH_TOKEN_FILE:-$ROOT/config/admin.token}"
SERVER="$ROOT/target/release/chronograph-server"

step() { printf '\n==> %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

# The service rejects any request whose Host does not match the configured public
# origin, so a custom port must move both together or the console answers 403.
# A wildcard bind is not browsable; show loopback instead. The listen address is
# parsed as an IPv4 literal, so reject the two shapes that would otherwise fail
# with an unrelated error.
case "$BIND" in
  0.0.0.0:*)   BROWSER_HOST="127.0.0.1:${BIND#0.0.0.0:}" ;;
  localhost:*) BIND="127.0.0.1:${BIND#localhost:}"; BROWSER_HOST="$BIND" ;;
  \[*)         die "CHRONOGRAPH_BIND=$BIND is an IPv6 address. The service accepts IPv4 literals only; use an address such as 127.0.0.1:8080." ;;
  *)           BROWSER_HOST="$BIND" ;;
esac
export CHRONOGRAPH_BIND="$BIND"
export CHRONOGRAPH_ORIGIN="${CHRONOGRAPH_ORIGIN:-http://$BROWSER_HOST}"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  step "Checking build prerequisites"
  command -v cargo >/dev/null 2>&1 || die "cargo not found. Install Rust 1.93+ from https://rustup.rs and re-run."
  command -v npm   >/dev/null 2>&1 || die "npm not found. Install Node 20.19+ or 22.12+ from https://nodejs.org and re-run."
  note "rustc $(rustc --version | awk '{print $2}')  ·  node $(node --version)  ·  npm $(npm --version)"

  step "Building the browser console (ui/dist)"
  if [ ! -d ui/node_modules ]; then
    note "installing npm dependencies"
    ( cd ui && npm ci )
  fi
  ( cd ui && npm run build )
  note "console built"

  step "Building the server (release, this takes a few minutes the first time)"
  cargo build --locked --release -p chronograph-server --bins
  note "server built"
fi

[ -x "$SERVER" ] || die "$SERVER is missing. Re-run without SKIP_BUILD=1."
[ -f "$ROOT/ui/dist/index.html" ] || die "ui/dist/index.html is missing. Re-run without SKIP_BUILD=1 to build the console."

# Both directories must exist before the service starts: credentials live
# outside graph data by design, so neither path implies the other.
mkdir -p "$(dirname "$AUTH")" "$(dirname "$TOKEN_FILE")" "$DATA"

if [ ! -f "$TOKEN_FILE" ]; then
  step "Creating an admin token"
  "$SERVER" admin create-token local-admin admin 90 "$TOKEN_FILE" >/dev/null
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
  note "written to $TOKEN_FILE (mode 0600)"
else
  step "Reusing the existing token"
  note "$TOKEN_FILE already exists; delete it to mint another"
fi

cat <<EOF

==> ChronoDB Community is starting

    Console     http://$BROWSER_HOST
    Token file  $TOKEN_FILE
    Workspace   $DATA
    Credentials $AUTH

    Open the console, then paste the contents of the token file when asked.
    The token stays in browser memory and is cleared on reload.
    Press Ctrl+C to stop; the log is synchronized on shutdown.

EOF

exec "$SERVER" serve
