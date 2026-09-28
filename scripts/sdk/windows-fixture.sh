#!/usr/bin/env bash
# A Linux server fixture on WSL1; all tested clients run as native Windows processes.
set -euo pipefail
umask 077
ROOT=$(mktemp -d /tmp/chronodb-windows-sdk-XXXXXX)
trap 'rm -rf "$ROOT"' EXIT
cp "$1/chronograph-server" "$ROOT/server"
chmod 0700 "$ROOT/server"
export CHRONOGRAPH_AUTH="$ROOT/auth.json"
export CHRONOGRAPH_DATA="$ROOT/data"
export CHRONOGRAPH_BIND=127.0.0.1:18092
export CHRONOGRAPH_ORIGIN=http://127.0.0.1:18092
"$ROOT/server" admin create-token 'Disposable Windows SDK fixture' admin 1 "$ROOT/admin.token" >/dev/null
cp "$ROOT/admin.token" "$1/admin.token"
"$ROOT/server" serve &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; rm -rf "$ROOT"; rm -f "$1/admin.token"' EXIT
wait "$SERVER"
