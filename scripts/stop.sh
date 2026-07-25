#!/usr/bin/env bash
# sharp — stop local dev servers so scripts/dev.sh can start cleanly again.
#
# dev.sh runs three things: the Rust server (:3000), the web dev server (:5173), and the
# Postgres/Redis/MinIO/LiveKit containers. Only the two host processes block a re-run (a
# bound port makes the next start fail); the containers are started idempotently by
# dev.sh, so they are left up by default.
#
#   scripts/stop.sh            # free :3000 and :5173
#   scripts/stop.sh --docker   # also take the dependency containers down
set -uo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$SHARP_ROOT"

DOWN_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    --docker | -d | --all) DOWN_DOCKER=true ;;
    -h | --help)
      echo "usage: scripts/stop.sh [--docker]"
      echo "  (no args)   stop the server (:${PORT_SERVER}) and web (:${PORT_WEB}) host processes"
      echo "  --docker    also stop the dependency containers"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg' (try --help)"
      exit 1
      ;;
  esac
done

kill_port "$PORT_SERVER" "sharp-server"
kill_port "$PORT_WEB" "web (vite)"

# Best-effort sweep of a server binary that is mid-build and not yet bound to the port
# (unique name, safe to target).
pkill -f "target/debug/sharp-server" 2>/dev/null || true

if [[ "$DOWN_DOCKER" == true ]]; then
  if command -v docker >/dev/null; then
    dev_deps_down
  else
    echo "==> docker not found — skipping container teardown"
  fi
else
  echo "==> leaving db containers up (dev.sh reuses them; use --docker to stop them)"
fi

echo "==> done — safe to run scripts/dev.sh"
