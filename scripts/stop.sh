#!/usr/bin/env bash
# sharp — stop local dev servers so scripts/dev.sh can start cleanly again.
#
# dev.sh runs three things: the Rust server (:3000), the web dev server
# (:5173), and the Postgres/Redis/MinIO containers. Only the two host
# processes block a re-run (a bound port makes the next start fail); the
# containers are started idempotently by dev.sh, so they're left up by default.
#
#   scripts/stop.sh            # free :3000 and :5173
#   scripts/stop.sh --docker   # also `docker compose ... down` the deps
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOWN_DOCKER=false
for arg in "$@"; do
  case "$arg" in
    --docker | -d | --all) DOWN_DOCKER=true ;;
    -h | --help)
      echo "usage: scripts/stop.sh [--docker]"
      echo "  (no args)   stop the server (:3000) and web (:5173) host processes"
      echo "  --docker    also stop the Postgres/Redis/MinIO containers"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$arg' (try --help)"
      exit 1
      ;;
  esac
done

# Kill whatever is listening on a TCP port, gently first then forcefully.
kill_port() {
  local port="$1" label="$2" pids
  pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    echo "==> :$port ($label) already free"
    return
  fi
  echo "==> stopping $label on :$port — pids: $(echo "$pids" | tr '\n' ' ')"
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6; do
    sleep 0.25
    pids="$(lsof -ti "tcp:$port" 2>/dev/null || true)"
    [[ -z "$pids" ]] && break
  done
  if [[ -n "$pids" ]]; then
    echo "    still up — force killing: $(echo "$pids" | tr '\n' ' ')"
    kill -9 $pids 2>/dev/null || true
  fi
}

kill_port 3000 "sharp-server"
kill_port 5173 "web (vite)"

# Best-effort sweep of a server binary that's mid-build / not yet bound to the
# port (unique name, safe to target).
pkill -f "target/debug/sharp-server" 2>/dev/null || true

if [[ "$DOWN_DOCKER" == true ]]; then
  if command -v docker >/dev/null; then
    echo "==> stopping postgres + redis + minio (docker)"
    docker compose -f deploy/docker-compose.dev.yml down
  else
    echo "==> docker not found — skipping container teardown"
  fi
else
  echo "==> leaving db containers up (dev.sh reuses them; use --docker to stop them)"
fi

echo "==> done — safe to run scripts/dev.sh"
