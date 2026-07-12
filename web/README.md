# sharp — web client

The React + Vite + TypeScript SPA for **sharp**, a self-hosted Slack replacement.
Built against the contract in [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

## Stack

- Vite 6 + React 18 + TypeScript
- react-router-dom (routing)
- zustand (state)
- Tailwind CSS v4 (via `@tailwindcss/vite`, single `@import "tailwindcss"`)
- react-markdown + remark-gfm (message rendering, no raw HTML)

## Develop

```bash
bun install
bun run dev
```

The dev server runs on `http://localhost:5173` and proxies `/api` (including the
WebSocket at `/api/v1/ws`) to `http://localhost:3000`, so run the Rust server on
port 3000 alongside it. With the proxy, the app talks to `window.location.origin`
by default — no extra config needed.

## Build

```bash
bun run build      # tsc --noEmit && vite build  ->  dist/
bun run preview    # serve the production build locally
```

The Rust server serves `web/dist` as static files with SPA fallback (see
`WEB_DIST` in the architecture doc), so `bun run build` output drops straight in.

## Server URL resolution

The API/WS base URL is resolved in this order:

1. `import.meta.env.VITE_API_URL` — set at build time, e.g.
   `VITE_API_URL=https://chat.example.com bun run build`
2. `localStorage['sharp.serverUrl']` — set from the login screen's **Server URL**
   field, which only appears when running inside the Tauri desktop shell
   (`'__TAURI_INTERNALS__' in window`)
3. `window.location.origin` — the default when the SPA is served by the sharp
   server itself

The JWT is stored in `localStorage['sharp.token']` and sent as
`Authorization: Bearer <jwt>`. A `401` clears the token and redirects to `/login`.

## Environment variables

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | Absolute base URL of the sharp server (optional). Leave unset for same-origin or Tauri (server chosen at login). |

## Project layout

```
src/
├── lib/
│   ├── api.ts      # typed fetch client (base URL + Bearer + 401 handling)
│   ├── ws.ts       # websocket client (reconnect w/ backoff + jitter)
│   ├── types.ts    # wire types copied from the contract
│   ├── util.ts     # dates, id compare, fuzzy match, avatars
│   └── toast.ts    # tiny toast store
├── store.ts        # zustand store + WS event application
├── components/     # Sidebar, MessagePane, ThreadPanel, Composer, QuickSwitcher, …
├── App.tsx         # routes + session bootstrap
└── main.tsx        # entrypoint
```

## Features

Auth (login/register) · public/private channels · DMs · markdown messages · threads
· edit/soft-delete · reactions · `@mentions` · typing indicators · presence ·
per-channel unread counts + read cursor · full-text search · ⌘K quick switcher ·
infinite scroll · realtime via WebSocket with auto-reconnect.
