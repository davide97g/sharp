// Points Excalidraw at self-hosted fonts. Import this BEFORE importing
// `@excalidraw/excalidraw` — the editor reads `window.EXCALIDRAW_ASSET_PATH`
// when it first loads a font, and without it every font request goes to a
// public CDN (this app never talks to one).
//
// The tree under `/excalidraw-assets/fonts` is mirrored out of the package by
// the `sharp-excalidraw-assets` plugin in `vite.config.ts`; the paths inside the
// editor are relative (`./fonts/<Family>/<file>.woff2`), so the base must end
// in a slash.
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}

window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/'

export {}
