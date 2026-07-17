---
title: Self-hosting
order: 8
---

For local use, run `./scripts/dev.sh`. It starts Postgres and Redis, then the Rust API and Vite web app. A full Docker-only local stack is also available in `deploy/docker-compose.local.yml`.

Production options include the Caddy/VPS compose stack and Dokploy/Traefik. Configure a strong `JWT_SECRET`, Postgres, and your public app URL. S3-compatible storage enables attachments; Redis enables multi-replica real-time fanout; Google OAuth enables calendar connections. The server can serve the built SPA itself or run separately from the web and landing services.
