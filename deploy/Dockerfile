# syntax=docker/dockerfile:1
#
# sharp — production image (one container serves the API + the built web SPA).
#
# IMPORTANT: the build context MUST be the repository root, so the builder can see
# both `web/` and `server/`. docker-compose.yml already sets `context: ..`.
# To build by hand from the repo root:
#     docker build -f deploy/Dockerfile -t sharp .
#
# Multi-stage:
#   1. bun   — build the React/Vite web SPA          -> /web/dist
#   2. rust  — build the axum server (release)       -> the server binary
#   3. debian slim runtime — server binary + web dist, serving both on $PORT

# ---------- 1. web builder ----------
FROM oven/bun:1-alpine AS web
WORKDIR /web
# Install deps first for better layer caching.
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY web/ ./
# VITE_API_URL is intentionally unset: the SPA is served same-origin by the server,
# so it uses window.location.origin for the API/WS base.
RUN bun run build

# ---------- 2. server builder ----------
# bookworm (glibc) rather than alpine/musl — friendlier for sqlx & the crypto crates.
FROM rust:1-bookworm AS server
WORKDIR /src
COPY server/ ./
# No compile-time DATABASE_URL needed: the server uses sqlx runtime queries only.
RUN cargo build --release
# The server crate is expected to be `sharp-server`; to stay robust to the exact
# package name we copy whichever single executable landed in target/release/.
RUN set -eux; \
    bin="$(find target/release -maxdepth 1 -type f -executable ! -name '*.d' | head -n1)"; \
    test -n "$bin"; \
    cp "$bin" /sharp

# ---------- 3. runtime ----------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /sharp /app/sharp
COPY --from=web /web/dist /app/web-dist

ENV WEB_DIST=/app/web-dist \
    PORT=3000 \
    RUST_LOG=info
EXPOSE 3000

CMD ["/app/sharp"]
