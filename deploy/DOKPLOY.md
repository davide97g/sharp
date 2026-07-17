# Deploying sharp with Dokploy

Dokploy brings its own Traefik with automatic Let's Encrypt, so use
`deploy/docker-compose.dokploy.yml` (no Caddy, no published ports).

This is a **split deployment** across three subdomains:

| Subdomain                      | Service   | Port | What it is             |
| ------------------------------ | --------- | ---- | ---------------------- |
| `sharp.davideghiotto.it`       | `landing` | 80   | Static landing page    |
| `app.sharp.davideghiotto.it`   | `web`     | 80   | React SPA (chat UI)    |
| `server.sharp.davideghiotto.it`| `sharp`   | 3000 | API + WebSocket server |

The web SPA is a separate static image that talks **cross-origin** to the API
host. That works with no extra config: the server's CORS is permissive and auth
is a Bearer token in `localStorage` (no cookies). The API base is baked into the
web image at build time (`API_URL` below) — change the domain there, not at runtime.

## Prerequisites

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`)
- DNS A records pointing at the VPS for all three hosts:
  `sharp.davideghiotto.it`, `app.sharp.davideghiotto.it`, `server.sharp.davideghiotto.it`
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

5. **Domains** tab — add three domains (all HTTPS on, Certificate: Let's Encrypt):

   | Host                            | Service   | Container port |
   | ------------------------------- | --------- | -------------- |
   | `sharp.davideghiotto.it`        | `landing` | 80             |
   | `app.sharp.davideghiotto.it`    | `web`     | 80             |
   | `server.sharp.davideghiotto.it` | `sharp`   | 3000           |

   (WebSockets work through Traefik with no extra config.)

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
