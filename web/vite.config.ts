import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// Unique per build. Stamped into sw.js so every deploy changes its bytes —
// that's what makes browsers install the update and swap the app immediately.
const buildId = `${pkg.version}-${Date.now().toString(36)}`

function stampServiceWorker(): Plugin {
  return {
    name: 'sharp-stamp-sw',
    apply: 'build',
    closeBundle() {
      const swPath = fileURLToPath(new URL('./dist/sw.js', import.meta.url))
      const source = readFileSync(swPath, 'utf8')
      writeFileSync(swPath, source.replaceAll('__BUILD_ID__', buildId))
    },
  }
}

// Excalidraw loads its fonts at runtime from `window.EXCALIDRAW_ASSET_PATH`, and
// silently falls back to a public CDN when a file 404s. This app must never reach
// a third-party CDN, so the font tree is mirrored into `public/excalidraw-assets/`
// (gitignored, re-copied whenever the package version changes) and
// `lib/excalidrawAssets.ts` points the editor at it.
function copyExcalidrawAssets(): Plugin {
  return {
    name: 'sharp-excalidraw-assets',
    config() {
      const pkgPath = './node_modules/@excalidraw/excalidraw/package.json'
      const source = fileURLToPath(
        new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url),
      )
      if (!existsSync(source)) return
      const version = JSON.parse(
        readFileSync(fileURLToPath(new URL(pkgPath, import.meta.url)), 'utf8'),
      ).version as string
      const target = fileURLToPath(new URL('./public/excalidraw-assets', import.meta.url))
      const stamp = `${target}/.version`
      if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      cpSync(source, `${target}/fonts`, { recursive: true })
      writeFileSync(stamp, version)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), copyExcalidrawAssets(), stampServiceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Same id stamped into sw.js — the Settings → About tab shows it, so you
    // can verify a deploy actually reached the client you're looking at.
    __BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    proxy: {
      '/api': {
        // IPv4 explicitly: `localhost` can resolve to ::1 first and hit an
        // unrelated dev server that grabbed the IPv6 side of port 3000.
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
