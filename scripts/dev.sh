#!/usr/bin/env bash
# sharp — one-command local dev environment.
# Boots dependencies (Docker), the Rust server (:3000), and the web app (:5173).
#
# Ctrl-C stops the two host processes; the containers stay up for the next run
# (scripts/stop.sh --docker takes them down).
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$SHARP_ROOT"

require_bins docker cargo bun

dev_deps_up
dev_env

cleanup() {
  echo; echo "==> shutting down"
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

echo "==> building & starting sharp-server (first build takes a few minutes)"
(cd server && cargo run) &
SERVER_PID=$!

echo "==> starting web dev server"
(cd web && { [ -d node_modules ] || bun install; } && bun run dev) &
WEB_PID=$!

echo
echo "  sharp is coming up:"
echo "    api    -> http://localhost:${PORT_SERVER}/api/v1/healthz"
echo "    app    -> http://localhost:${PORT_WEB}"
echo
echo "  Ctrl-C stops everything (db containers keep running; stop them with"
echo "  'scripts/stop.sh --docker')"
echo

wait
