#!/usr/bin/env bash
# sharp — one-command local dev environment.
# Boots Postgres+Redis (Docker), the Rust server (:3000) and the web app (:5173).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for bin in docker cargo bun; do
  command -v "$bin" >/dev/null || { echo "error: '$bin' is required (install it first)"; exit 1; }
done

echo "==> starting postgres + redis (docker)"
docker compose -f deploy/docker-compose.dev.yml up -d

echo "==> waiting for postgres"
until docker compose -f deploy/docker-compose.dev.yml exec -T postgres pg_isready -U sharp -d sharp >/dev/null 2>&1; do
  sleep 1
done

export DATABASE_URL="postgres://sharp:sharp@localhost:5432/sharp"
export REDIS_URL="redis://localhost:6379"
export JWT_SECRET="dev-only-secret-do-not-use-in-prod"
export RUST_LOG="${RUST_LOG:-info}"

# File uploads -> local MinIO (from docker-compose.dev.yml).
export S3_ENDPOINT="http://localhost:9000"
export S3_BUCKET="sharp"
export S3_ACCESS_KEY="sharp"
export S3_SECRET_KEY="sharp-secret"
export S3_REGION="us-east-1"
export S3_ALLOW_HTTP="true"
# Web push: VAPID keys auto-generate + persist on first start (no config needed).

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
echo "    api    -> http://localhost:3000/api/v1/healthz"
echo "    app    -> http://localhost:5173"
echo
echo "  Ctrl-C stops everything (db containers keep running; stop with"
echo "  'docker compose -f deploy/docker-compose.dev.yml down')"
echo

wait
