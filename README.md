# # sharp

**Self-hosted team chat. Sharp as `#`.**

sharp is an open-source, self-hostable Slack replacement: channels, threads, DMs,
reactions, mentions, presence and full-text search — running on *your* server, from a
single binary backed by Postgres.

> Milestone 1 of a larger plan: chat first, then Notion-style docs, then a Miro-style
> canvas — all sharing one workspace, identity and permission model.
> See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

- **Server** — Rust (axum, sqlx/Postgres, optional Redis fanout). Serves the API *and* the web app.
- **Web** — React + Vite + TypeScript + Tailwind.
- **Desktop** — Tauri 2 (macOS, Windows, Linux) wrapping the same web app.
- **Landing** — Astro static site.

## Quick start (self-host)

```bash
git clone https://github.com/YOUR_GITHUB_USER/sharp && cd sharp/deploy
cp .env.example .env   # set JWT_SECRET + POSTGRES_PASSWORD (+ your domain for TLS)
docker compose up -d
```

Open your server's address, register the first account, create `#general`, invite the team.

## Development

```bash
# server (needs Rust + a Postgres; see deploy/docker-compose.dev.yml)
cd server && cargo run

# web
cd web && npm install && npm run dev   # proxies /api to localhost:3000

# desktop
cd desktop && npm install && npm run tauri dev

# landing
cd landing && npm install && npm run dev
```

## Repo layout

`server/` Rust API + websocket · `web/` React SPA · `desktop/` Tauri shell ·
`landing/` Astro site · `deploy/` docker-compose + Caddy · `docs/` architecture.

## License

[AGPL-3.0](LICENSE). Run it, fork it, sell hosting for it — just publish your changes.
