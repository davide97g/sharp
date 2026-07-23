import { readFileSync, writeFileSync } from 'node:fs'
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

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Same id stamped into sw.js — the Settings → About tab shows it, so you
    // can verify a deploy actually reached the client you're looking at.
    __BUILD_ID__: JSON.stringify(buildId),
  },
  optimizeDeps: {
    // `@tldraw/assets/imports.vite` resolves fonts/icons via Vite `?url` imports.
    // esbuild's dep pre-bundling can't handle `?url` (URLs come back undefined and
    // getAssetUrlsByImport() throws), so let Vite process this package natively.
    exclude: ['@tldraw/assets'],
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
