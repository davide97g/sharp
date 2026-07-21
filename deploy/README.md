# Deploying sharp on a VPS

> **Using Dokploy?** See [DOKPLOY.md](DOKPLOY.md) and use
> `docker-compose.dokploy.yml` instead — Dokploy's Traefik replaces Caddy.

One command brings up the whole stack: Postgres, Redis, LiveKit SFU, the sharp
server (API + web SPA in one container), and Caddy.

```
postgres ─┐
redis ────┤
sharp ────┼──> caddy :80/:443 ──> the internet
livekit ──┤       └── media:7881/tcp, 3478/udp, 5349/tcp, 30000-30100/udp, 50000-60000/udp
landing ──┘
```

## 1. DNS

Point A (and AAAA if you have IPv6) records at your server's IP:

| Record            | Type | Value           |
| ----------------- | ---- | --------------- |
| `chat.example.com`| A    | `<your-server-ip>` |
| `media.example.com`| A   | `<your-server-ip>` |
| `example.com`     | A    | `<your-server-ip>` |

(Use whatever hostnames you set for `SHARP_DOMAIN` / `LANDING_DOMAIN` below.)

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

Docker Compose v2 ships with the Docker Engine (`docker compose ...`).

## 3. Clone & configure

```bash
git clone https://github.com/davide97g/sharp
cd sharp/deploy
cp .env.example .env
```

Edit `.env` and set:

- `POSTGRES_PASSWORD` — a strong password
- `JWT_SECRET` — 64+ random chars (`openssl rand -base64 48`)
- `SHARP_DOMAIN`, `MEDIA_DOMAIN`, `LANDING_DOMAIN`, `ACME_EMAIL` — domains + TLS email
- `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — SFU signing credentials
- `LIVEKIT_TURN_CERT_FILE`, `LIVEKIT_TURN_KEY_FILE` — absolute host paths to a
  trusted certificate/key for `MEDIA_DOMAIN`; TURN/TLS listens on 5349 because
  Caddy owns 443

Open firewall ports `7881/tcp`, `3478/udp`, `5349/tcp`, and
`30000-30100/udp` (TURN relay), and `50000-60000/udp`. Strict networks allowing only TCP 443 may not connect on this
single-IP topology; use a second public IP or dedicated media VM when that
coverage is required.

Build the landing page so Caddy can serve it (optional, only if you use the
`landing` mount):

```bash
( cd ../landing && bun install && bun run build )
```

## 4. Launch

```bash
docker compose up -d
```

The first build compiles the Rust server and the web app; give it a few minutes.
Check health:

```bash
docker compose ps
docker compose logs -f sharp
docker compose logs -f livekit
curl -s https://$SHARP_DOMAIN/api/v1/healthz   # {"status":"ok"}
```

### No custom domain / no TLS?

Delete (or don't start) the `caddy` service and expose sharp directly by
uncommenting its `ports:` block in `docker-compose.yml`, then browse to
`http://<server-ip>:3000`.

## 5. First user & closing signup

Open the app and **register the first account** — the first registration on a fresh
instance is always allowed. Create `#general`, invite your team.

Once everyone is in, close public registration:

```bash
# in .env
SHARP_DISABLE_SIGNUP=true

docker compose up -d sharp    # recreates the container with the new env
```

## 6. Updating

```bash
cd sharp
git pull
cd deploy
docker compose build
docker compose up -d
```

Database migrations run automatically on server startup.

LiveKit media is ephemeral and needs no backup. Before certificate renewal
expires, renew the `MEDIA_DOMAIN` files and run `docker compose restart livekit`
so TURN/TLS reloads them.

## 7. Backups

Everything durable lives in Postgres. Dump it regularly:

```bash
# Snapshot to a timestamped file on the host:
docker compose exec -T postgres pg_dump -U sharp sharp \
  | gzip > sharp-$(date +%F).sql.gz
```

Restore into a fresh database:

```bash
gunzip -c sharp-2026-01-01.sql.gz \
  | docker compose exec -T postgres psql -U sharp -d sharp
```

Also worth backing up: the `caddy_data` volume (TLS certificates) so you don't
re-issue on migration, though Caddy will happily re-provision them.

## Local development

For local dependencies on your laptop (run server/web on the host):

```bash
docker compose -f docker-compose.dev.yml up -d
# DATABASE_URL=postgres://sharp:sharp@localhost:5432/sharp
# REDIS_URL=redis://localhost:6379
# LIVEKIT_URL=ws://localhost:7880
# LIVEKIT_INTERNAL_URL=http://localhost:7880
# LIVEKIT_API_KEY=devkey
# LIVEKIT_API_SECRET=secret
```
