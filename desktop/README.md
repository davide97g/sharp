# sharp desktop

A [Tauri 2](https://v2.tauri.app) shell that wraps the sharp web app as a native
desktop application for macOS, Windows and Linux.

The frontend is the built web SPA (`../web/dist`). Because `VITE_API_URL` is left
unset for desktop builds, the login screen shows a "server" field (detected via
`__TAURI_INTERNALS__`) where the user enters their server URL; it is persisted in
localStorage.

## Prerequisites

- Node 22+
- Rust (stable) + the platform build tools Tauri needs
  (see https://v2.tauri.app/start/prerequisites/)

## Develop

```bash
npm install
npm run tauri dev     # runs `npm --prefix ../web run dev` and opens the shell
```

## Build

```bash
npm run tauri build   # runs `npm --prefix ../web run build` first, then bundles
```

Bundle targets are `all` (macOS `.dmg`, Windows NSIS `.exe`, Linux AppImage/`.deb`),
resolved per host platform. CI builds these on tags via `tauri-apps/tauri-action`
(see `.github/workflows/release.yml`).

## Icons (required once, locally)

Icon binaries are **not** committed — the Tauri CLI generates every platform icon
from a single source SVG/PNG. `tauri.conf.json` references `icons/icon.png`, so run
this once (from `desktop/`) before your first `tauri build`:

```bash
npm run tauri icon assets/icon.svg
```

This creates `src-tauri/icons/` (icon.png, icon.icns, icon.ico, and the various
`*.png` sizes). The source mark is `assets/icon.svg` (the `#` glyph on the accent
background). The release CI workflow runs this step automatically.

## Plugins / permissions

Two plugins are registered in `src-tauri/src/lib.rs` and granted in
`src-tauri/capabilities/default.json`:

- **tauri-plugin-notification** (`notification:default`) — new-message notifications
  when the window is unfocused.
- **tauri-plugin-shell** (`shell:allow-open`) — open external links in the system
  browser.

v1 registers the plugins; the web frontend calls them through the Tauri JS API when
available (feature-detected), and falls back to browser behaviour otherwise.
