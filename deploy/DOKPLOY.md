# Deploying sharp with Dokploy

Dokploy brings its own Traefik with automatic Let's Encrypt, so use
`deploy/docker-compose.dokploy.yml` (no Caddy, no published ports).

## Prerequisites

- A VPS with Dokploy installed (`curl -sSL https://dokploy.com/install.sh | sh`)
- DNS A records pointing at the VPS: `chat.example.com` (app) and optionally
  `example.com` (landing)
- The sharp repo pushed to GitHub (public or with the Dokploy GitHub app installed)

## App + database (Compose service)

1. Dokploy → **Create Project** → `sharp`.
2. Inside the project: **Create Service → Compose** (type: Docker Compose).
3. Provider: your Git provider → repo `sharp` → branch `main` →
   **Compose Path:** `deploy/docker-compose.dokploy.yml`.
4. **Environment** tab — add:

   ```env
   POSTGRES_PASSWORD=<long random string>
   JWT_SECRET=<64 random chars>          # e.g. openssl rand -hex 32
   SHARP_DISABLE_SIGNUP=false
   ```

5. **Domains** tab — add domain:
   - Host: `chat.example.com`
   - Service name: `sharp`, Container port: `3000`
   - HTTPS: on, Certificate: Let's Encrypt
   (WebSockets work through Traefik with no extra config.)
6. **Deploy**. First build compiles the Rust server + web app (several minutes;
   subsequent builds hit Docker layer cache).
7. Open `https://chat.example.com`, register your account (first user), create
   `#general`. Once the team has joined, set `SHARP_DISABLE_SIGNUP=true` and
   redeploy to close registration.

## Landing page

Option A (same stack): the compose file already includes a `landing` service —
just add a second domain on the Compose service: host `example.com`,
service `landing`, port `80`.

Option B (separate app): **Create Service → Application**, same repo,
Build Type: **Dockerfile**, Docker File: `deploy/Dockerfile.landing`,
Docker Context Path: `.` — then add domain `example.com`, port `80`.

## Auto-deploy on push

Enable **Auto Deploy** on the service (Dokploy sets up the GitHub webhook) —
every push to `main` redeploys.

## Backups

Dokploy → your Compose service → **Backups**: schedule a Postgres backup of the
`postgres` service (database `sharp`, user `sharp`) to S3-compatible storage.
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
