import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
