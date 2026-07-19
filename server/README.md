# sharp-server

The Rust backend for **sharp** — axum + sqlx (Postgres) with optional Redis fanout.
It serves the `/api/v1/*` REST + WebSocket API and, when built, the web SPA as static
files with SPA fallback.

## Requirements

- Rust (stable) with `cargo`
- PostgreSQL >= 15 (uses `gen_random_uuid()`, generated columns, FTS)
- Redis 7 (optional — only needed for multi-replica fanout)

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | yes | — | Postgres connection string, e.g. `postgres://user:pass@localhost/sharp` |
| `JWT_SECRET` | yes | — | HMAC secret for signing JWTs (HS256, 30-day expiry) |
| `PORT` | no | `3000` | TCP port to listen on |
| `REDIS_URL` | no | — | If set, events are published/consumed on `sharp:events` for cross-replica sync |
| `WEB_DIST` | no | `./web-dist` | Directory of the built SPA. If missing, the server runs API-only |
| `SHARP_DISABLE_SIGNUP` | no | `false` | `true`/`1` blocks registration — except when the users table is empty (first user) |
| `WEBAUTHN_RP_ID` | no | — | Stable WebAuthn relying-party domain; enables passkeys with `WEBAUTHN_ORIGINS` |
| `WEBAUTHN_ORIGINS` | no | — | Comma-separated exact HTTPS origins allowed for passkey ceremonies |
| `WEBAUTHN_RP_NAME` | no | `Sharp` | Name shown by authenticator UI |
| `RUST_LOG` | no | `info` | Tracing filter, e.g. `sharp_server=debug,tower_http=debug` |

## Running

```bash
# from server/
export DATABASE_URL="postgres://sharp:sharp@localhost:5432/sharp"
export JWT_SECRET="change-me-in-production"
export RUST_LOG=info

cargo run --release
```

Migrations in `migrations/` are embedded at compile time and run automatically on startup.

## API

Base path `/api/v1`, auth via `Authorization: Bearer <jwt>`. Message ids are serialized
as strings. See `../docs/ARCHITECTURE.md` for the full contract.

- `POST /auth/register`, `POST /auth/login`
- `POST /auth/passkeys/login/start`, `POST /auth/passkeys/login/finish`
- `GET|POST /auth/passkeys`, `POST /auth/passkeys/register/finish`
- `GET /me`, `GET /users`
- `GET /channels`, `POST /channels`, `POST /channels/dm`
- `POST /channels/{id}/join`, `POST /channels/{id}/leave`
- `GET /channels/{id}/members`, `POST /channels/{id}/read`
- `GET /channels/{id}/messages`, `POST /channels/{id}/messages`
- `GET /messages/{id}/thread`, `PATCH /messages/{id}`, `DELETE /messages/{id}`
- `PUT|DELETE /messages/{id}/reactions/{emoji}`
- `GET /search?q=&limit=`
- `GET /healthz`
- `GET /ws?token=<jwt>` — WebSocket, envelope `{ "type": string, "payload": object }`

## Development notes

- sqlx is used **without** compile-time query macros (runtime `query`/`query_as` with
  manual `Row::try_get`), so no `DATABASE_URL` is required at build time.
- Build with `cargo build --release`; lint with `cargo clippy`; format with `cargo fmt`.
