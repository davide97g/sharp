#!/usr/bin/env bash
# Shared helpers for the scripts in this directory. Source it, don't run it:
#
#   source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
#
# Every script here needs the same four things — locate the repo root, check the tools it
# needs are installed, drive the dev containers, and free a bound port — and each had its
# own copy. The dev-container compose path and the two dev port numbers in particular were
# repeated across dev.sh and stop.sh, where they have to agree.

# Repo root, resolved from this file's own location at source time — so it is correct no
# matter which directory a script is invoked from, and does not depend on the caller's
# position in the call stack.
SHARP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SHARP_ROOT

# The dev-dependency stack: Postgres, Redis, MinIO, LiveKit.
DEV_COMPOSE="deploy/docker-compose.dev.yml"

# Ports the dev environment binds on the host. dev.sh starts them; stop.sh frees them.
PORT_SERVER=3000
PORT_WEB=5173

# Fail with a message unless every named binary is on PATH.
require_bins() {
  local missing=0 bin
  for bin in "$@"; do
    command -v "$bin" >/dev/null || {
      echo "error: '$bin' is required (install it first)" >&2
      missing=1
    }
  done
  [[ $missing -eq 0 ]] || exit 1
}

# Start the dev containers (idempotent) and block until Postgres accepts connections.
# Migrations run on server startup, so the server must not start before this returns.
dev_deps_up() {
  echo "==> starting postgres + redis + minio + livekit (docker)"
  docker compose -f "$DEV_COMPOSE" up -d

  echo "==> waiting for postgres"
  until docker compose -f "$DEV_COMPOSE" exec -T postgres pg_isready -U sharp -d sharp \
    >/dev/null 2>&1; do
    sleep 1
  done
}

dev_deps_down() {
  echo "==> stopping postgres + redis + minio + livekit (docker)"
  docker compose -f "$DEV_COMPOSE" down
}

# Kill whatever holds a TCP port: TERM first, then KILL if it is still there after ~1.5s.
# A bound port is what makes the next dev.sh run fail, so this is about restartability
# rather than cleanliness.
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

# The dev server's environment. Values match deploy/docker-compose.dev.yml — change both
# together. Secrets here are deliberately weak and local-only; see deploy/.env.example for
# the real configuration surface, including every optional integration left unset here.
dev_env() {
  export DATABASE_URL="postgres://sharp:sharp@localhost:5432/sharp"
  export REDIS_URL="redis://localhost:6379"
  export JWT_SECRET="dev-only-secret-do-not-use-in-prod"
  export RUST_LOG="${RUST_LOG:-info}"

  export LIVEKIT_URL="ws://localhost:7880"
  export LIVEKIT_INTERNAL_URL="http://localhost:7880"
  export LIVEKIT_API_KEY="devkey"
  export LIVEKIT_API_SECRET="secret"

  # File uploads -> the local MinIO from the dev compose file.
  export S3_ENDPOINT="http://localhost:9000"
  export S3_BUCKET="sharp"
  export S3_ACCESS_KEY="sharp"
  export S3_SECRET_KEY="sharp-secret"
  export S3_REGION="us-east-1"
  export S3_ALLOW_HTTP="true"

  # Web push needs nothing: VAPID keys auto-generate and persist on first start.
}
