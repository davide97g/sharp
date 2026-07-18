import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { registerServiceWorker } from './lib/notify'
import { installIosViewportFix } from './lib/iosViewport'
import './index.css'

installIosViewportFix()

// Tauri on macOS uses titleBarStyle: Overlay — the traffic lights float over
// the content. Reserve a top inset (via --titlebar-h) and add a draggable
// strip so the window can still be moved by that region.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac/i.test(navigator.platform || navigator.userAgent)
if (isTauri && isMac) {
  document.documentElement.setAttribute('data-tauri-mac', '')
  const bar = document.createElement('div')
  bar.className = 'titlebar-drag'
  bar.setAttribute('data-tauri-drag-region', '')
  document.body.appendChild(bar)
}

// Register in production only — Vite HMR fights a caching SW in dev.
if (import.meta.env.PROD) void registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
