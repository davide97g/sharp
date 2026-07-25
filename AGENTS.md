# AGENTS.md

Start with **[`CLAUDE.md`](CLAUDE.md)** — what this repo is, the commands, and the architecture
essentials. Then **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** for the invariants and the
"where do I change what" table, and **[`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md)** before
writing any styled JSX. Those three are not repeated here.

Below is only what they do not cover: preferences and workspace facts learned from the user
across sessions.

## Learned user preferences

- Prefer web-app mobile UX only; skip native iOS/Android app work unless explicitly requested.
  `mobile/` (Expo) is out of scope by default — ask before touching it.
- For mobile web, prioritize chat + shell first and use bottom tabs for primary navigation.
- For substantial UI/UX work, use the frontend-design and ui-ux-pro-max skills.
- When scope is clear, choose reasonable defaults and avoid extra clarifying questions; respect
  iOS safe-area insets in PWA/standalone mode.
- Voice/video must stay a collapsible, resizable app overlay so chat, docs, and canvas remain
  usable underneath.
- Prefer Google Meet-style mic/camera device dropdowns; keep the video stage immersive /
  full-viewport rather than cramped card layouts.
- Chat image clicks should open an in-app fullscreen lightbox (Esc/X to close), not a new tab.
- Prefer a single polished notification entry point over overlapping or fragmented
  notification UI.

## Learned workspace facts

- The web app is meant to be installable as a PWA on iOS and Android, with safe-area margins
  handled in standalone mode.
- Workspace GIF features use GIPHY with an approximate 100 requests/hour budget; usage and reset
  time should be visible in workspace settings.
- Automated "duck" GIF roast suggestions auto-pick from recent chat context and can send
  immediately; roast-sent GIFs must be excluded from later suggestion context.
- Landing marketing lives in `landing/` (Astro); product positioning includes Tasks as a
  Linear-lite tracker section.
