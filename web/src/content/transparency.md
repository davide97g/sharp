# What leaves your machine

sharp is self-hosted. This page is a plain inventory of every network
destination the app can reach, so you can verify the claim rather than take it
on faith. It is written against the code, not the marketing.

## Analytics and telemetry

**None.** There is no analytics SDK, no error reporter, no session recorder, no
"anonymous usage statistics" — not disabled by default, not present. Nothing
in the app phones home, because there is no home to phone. Search the source
for `sentry`, `posthog`, `plausible`, `gtag`, `mixpanel`, or `amplitude` and
you will find no dependency and no call site.

## Where your data goes

| Destination | What goes there | When |
|---|---|---|
| **Your sharp server** | Everything: messages, files, docs, canvases, boards, calls | Always — this is the app |
| **Your LiveKit server** | Audio, video, and screen-share media | Only during a call |
| **Nowhere else** | — | — |

Your server is the only party that sees your content. If you run it, nobody
else does.

## Optional integrations, off unless configured

Each of these is inert until an administrator sets the matching environment
variable. None is required, and none is enabled by default.

- **Sharpy (AI assistant)** — `AI_API_KEY`. When on, the text of messages and
  docs is sent to the configured provider to build the index and answer
  questions. Retrieval is filtered by your access, encrypted DMs are never
  indexed, and any channel can opt out entirely (Channel settings → *Hide from
  Sharpy*), which also deletes what was already indexed.
- **Transcription** — `TRANSCRIBE_API_KEY`. Call audio is streamed to the
  configured provider while transcription is running.
- **GIF search** — a GIPHY or Tenor key. Your search terms go to that provider.
- **Google Calendar** — `GOOGLE_*`. Only if you personally connect an account.
- **Email** — `RESEND_API_KEY` or `SMTP_*`. Used for password-reset mail only.
- **Push notifications** — your browser's push service (Google, Apple, Mozilla)
  or Apple's APNs. They relay an encrypted payload; set *Privacy → Notification
  previews* to "just new activity" if you would rather they carry nothing
  readable at all.

## What the app deliberately does not do

- **No link previews.** Pasting a URL never makes your server or your browser
  fetch it, so a link in a message cannot report that you read it.
- **No remote fonts, scripts, or images.** Everything is bundled and served by
  your own server — including the whiteboard assets, which are self-hosted
  rather than pulled from a CDN.
- **No read receipts.** The server tracks only your own last-read marker, to
  count your unreads. Nobody is told what you have read.

## Things you control

- **Appear offline** and **typing indicators** (Privacy) are enforced by the
  server, not just hidden in this app.
- **End-to-end encryption** for direct messages is automatic once both people
  have signed in on a device. Private keys never leave your browser; the server
  stores public keys and an opaque, passphrase-encrypted backup blob it cannot
  read.
- **Streaming shield** blurs private conversations while you share a screen.
