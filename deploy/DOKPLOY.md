# Deploying sharp with Dokploy

Dokploy brings its own Traefik with automatic Let's Encrypt, so use
`deploy/docker-compose.dokploy.yml` (no Caddy, no published ports).

This is a **split deployment** across four subdomains:

| Subdomain                      | Service   | Port | What it is             |
| ------------------------------ | --------- | ---- | ---------------------- |
| `sharp.davideghiotto.it`       | `landing` | 80   | Static landing page    |
| `app.sharp.davideghiotto.it`   | `web`     | 80   | React SPA (chat UI)    |
| `server.sharp.davideghiotto.it`| `sharp`   | 3000 | API + WebSocket server |
| `media.sharp.davideghiotto.it` | `livekit` | 7880 | SFU signaling/API      |

A fourth service, `db-studio` (Drizzle Gateway — the DB admin UI), runs
**privately with no public domain** — see [Database UI](#database-ui-drizzle-gateway).

The web SPA is a separate static image that talks **cross-origin** to the API
host. That works with no extra config: the server's CORS is permissive and auth
is a Bearer token in `localStorage` (no cookies). The API base is baked into the
web image at build time (`API_URL` below) — change the domain there, not at runtime.

## Prerequisites

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`)
- DNS A records pointing at the VPS for all three hosts:
  `sharp.davideghiotto.it`, `app.sharp.davideghiotto.it`, `server.sharp.davideghiotto.it`
  plus `media.sharp.davideghiotto.it` (the DB UI needs no DNS — it's private)
- The sharp repo on GitHub with the **Dokploy GitHub app** installed (for auto-deploy)

## Deploy (single Compose service, 3 domains)

1. Dokploy → **Create Project** → `sharp`.
2. Inside the project: **Create Service → Compose** (type: Docker Compose).
3. Provider: **GitHub** (via the GitHub app) → repo `sharp` → branch `main` →
   **Compose Path:** `deploy/docker-compose.dokploy.yml`.
4. **Environment** tab — add:

   ```env
   POSTGRES_PASSWORD=<long random string>
   JWT_SECRET=<64 random chars>              # e.g. openssl rand -hex 32
   MASTERPASS=<long unique string>           # login for the Drizzle Gateway DB UI
   MEDIA_DOMAIN=media.sharp.davideghiotto.it
   LIVEKIT_API_KEY=sharp-livekit
   LIVEKIT_API_SECRET=<64 random chars>
   LIVEKIT_TURN_CERT_FILE=/absolute/host/path/fullchain.pem
   LIVEKIT_TURN_KEY_FILE=/absolute/host/path/privkey.pem
   # Cloudflare R2 (S3 API) — create an R2 API token (dashboard → R2 →
   # Manage R2 API Tokens) to get the key pair. Endpoint has NO bucket suffix.
   S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
   S3_ACCESS_KEY=<R2 access key id>
   S3_SECRET_KEY=<R2 secret access key>
   SHARP_DISABLE_SIGNUP=false
   VAPID_SUBJECT=mailto:you@davideghiotto.it # contact URL for web-push
   # API base baked into the web image. Only change if the API host differs:
   # API_URL=https://server.sharp.davideghiotto.it
   # Optional — sensible defaults exist:
   # S3_BUCKET=sharp   S3_REGION=auto
   # GIFs & duck suggestions (optional; can also set the GIF key in-app,
   # Settings → Workspace — the env var is a fallback):
   # GIPHY_API_KEY=<key from developers.giphy.com>
   # DEEPSEEK_API_KEY=<key from platform.deepseek.com>   # duck disabled if unset
   # DEEPSEEK_MODEL=deepseek-chat   DEEPSEEK_BASE_URL=https://api.deepseek.com
   ```

   File uploads live in **Cloudflare R2** (any S3-compatible provider works —
   the server uses a generic S3 client). Create the bucket (default name
   `sharp`) in the R2 dashboard first; it stays fully private, since sharp
   proxies every upload/download through its own API with channel auth. The
   stack bundles **Redis** for multi-replica realtime (internal-only, no
   domain needed). Web-push VAPID keys auto-generate and persist in Postgres
   on first startup.

5. **Domains** tab — add four domains (all HTTPS on, Certificate: Let's Encrypt):

   | Host                            | Service   | Container port |
   | ------------------------------- | --------- | -------------- |
   | `sharp.davideghiotto.it`        | `landing` | 80             |
   | `app.sharp.davideghiotto.it`    | `web`     | 80             |
   | `server.sharp.davideghiotto.it` | `sharp`   | 3000           |
   | `media.sharp.davideghiotto.it`  | `livekit` | 7880           |

   Open host firewall ports `7881/tcp`, `3478/udp`, `5349/tcp`, and
   `50000-50100/udp`. WebSockets work through Traefik. Do **not** add a domain
   for `db-studio` — it stays private, see below.)

6. **Deploy**. First build compiles the Rust server + builds the web & landing
   SPAs (several minutes; subsequent builds hit Docker layer cache).
7. Open `https://app.sharp.davideghiotto.it`, register your account (first user),
   create `#general`. Once the team has joined, set `SHARP_DISABLE_SIGNUP=true`
   and redeploy to close registration.

> **Changing the API domain?** `API_URL` is a *build arg* — the web image must be
> rebuilt (redeploy) for a change to take effect. It cannot be flipped at runtime.

## Desktop app (macOS, dev/test)

The desktop build ships with `VITE_API_URL` unset, so on first launch users enter
the server URL manually: `https://server.sharp.davideghiotto.it`. Built locally &
signed manually — not part of this Dokploy stack.

## Database UI (Drizzle Gateway)

The `db-studio` service runs **Drizzle Gateway** — the official self-hosted
Drizzle Studio, a full web DB admin (browse tables, run SQL, edit rows).

It is deliberately **private: no public domain, no Traefik route.** Full
read/write database access must never sit on the open internet gated by a single
password. Instead the container publishes its port to the **VPS loopback only**
(`127.0.0.1:4983`), so it is unreachable from outside the host — you reach it
through an SSH tunnel from your laptop.

**Access it:**

1. Open a tunnel (keep it running in a terminal):

   ```bash
   ssh -N -L 4983:127.0.0.1:4983 <user>@<vps-host>
   ```

2. Browse to `http://127.0.0.1:4983` and log in with **MASTERPASS**.
3. Add the database connection **inside the UI** (persists in the
   `drizzle_gateway` volume — do this once):

   | Field    | Value                      |
   | -------- | -------------------------- |
   | Host     | `postgres`                 |
   | Port     | `5432`                     |
   | User     | `sharp`                    |
   | Database | `sharp`                    |
   | Password | your `POSTGRES_PASSWORD`   |
   | SSL      | off (same private network) |

   `db-studio` reaches Postgres by service name over the internal `default`
   network.

**Set `MASTERPASS`** in the Environment tab (a long, unique value):

```env
MASTERPASS=<long unique string>
```

> **Why not a public domain?** With a public route the only barrier to your
> entire database is one password — a permanent brute-force / leak target. The
> loopback + SSH-tunnel model means an attacker must first hold an SSH session on
> the VPS, so the DB UI has effectively zero standing internet exposure.
>
> **Upgrade path:** install Tailscale/WireGuard on the VPS and reach the tunnel
> over the tailnet instead of SSH. **Do not** change the port binding to
> `0.0.0.0` or add a Domains-tab entry for `db-studio` — that re-exposes it.

## Auto-deploy on push

The service uses the GitHub app as its Git provider, so enable **Auto Deploy** on
the Compose service — every push to `main` redeploys automatically (Dokploy
registers the webhook through the app).

## Backups

Dokploy → your Compose service → **Backups**: schedule a Postgres backup of the
`postgres` service (database `sharp`, user `sharp`) to S3-compatible storage.
Postgres holds all messages, docs, canvases and web-push keys. Uploaded files
live in Cloudflare R2, which has its own durability — no extra backup needed.
Manual alternative:

```bash
docker exec $(docker ps -qf name=postgres) pg_dump -U sharp sharp > sharp-$(date +%F).sql
```

## Notes

- The `dokploy-network` external network is required — Traefik reaches
  containers through it. Already declared in the compose file.
- Don't publish ports 80/443/3000 in compose; Traefik owns 80/443.
- Server resources: sharp is a single lean binary; 1 vCPU / 1 GB is plenty to
  start. Postgres appreciates whatever RAM you can spare.
- The Caddy files (`Caddyfile`, `docker-compose.yml`, `.env.example`) are for a
  non-Dokploy VPS and are unused here.
