# Pricing — sharp

sharp is open-source software you run yourself. There is one tier, it is free, and there is no
hosted edition to upsell you to.

Last updated: 2026-07-26 · version 0.3.0 · https://sharp.davideghiotto.it

## Self-hosted (the only tier)

- Price: $0/month
- License: AGPL-3.0
- Users: unlimited — no seat count, no per-user billing
- Message history: unlimited, retained until you delete it
- Feature gates: none. Chat, threads, DMs, collaborative docs, whiteboards, kanban boards,
  calendar, voice/video calls, screen sharing, idea boards, AI assistant and end-to-end
  encrypted DMs are all in the same build.
- Call limits: 25 participants, 16 cameras, 1 screen share per room (product limits, not
  license limits — they live in the source)
- Support: GitHub issues, community
- Requirements: Docker Compose host + Postgres 16 with pgvector (both in the bundled compose
  file)

## What you actually pay for

You pay your own infrastructure bill, not a license:

- Server: a small VPS is enough for a handful of people (roughly $5–10/month at common
  providers). Voice and video are the heavy part — a busy call room wants more CPU and
  bandwidth than chat does.
- Object storage: optional S3 or MinIO bucket for uploads; MinIO on the same box costs nothing
  extra.
- LiveKit: self-hosted alongside sharp, so also just infrastructure.
- AI assistant: optional, and billed by whichever OpenAI-compatible provider you point it at.
  A local model costs nothing beyond your hardware.
- Email (password reset): optional Resend or any SMTP provider; both have free tiers.

## Not available

- No hosted/cloud edition
- No enterprise tier, no commercial license, no CLA
- No paid support contract

## Links

- Source: https://github.com/davide97g/sharp
- License: https://github.com/davide97g/sharp/blob/main/LICENSE
- Deploy guide: https://github.com/davide97g/sharp/tree/main/deploy
- Environment reference: https://github.com/davide97g/sharp/blob/main/deploy/.env.example
