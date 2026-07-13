import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api, getToken, setUnauthorizedHandler } from './lib/api'
import { setNavigate as setDocNavigate } from './lib/nav'
import { setNavigate as setNotifyNavigate } from './lib/notify'
import { useStore } from './store'
import { Login } from './components/Login'
import { AppShell } from './components/AppShell'
import { MessagePane } from './components/MessagePane'
import { SearchResults } from './components/SearchResults'
import { Home } from './components/Home'
import { Toasts } from './components/Toasts'
import { DocsHome } from './components/docs/DocsHome'
import { ChannelDocs } from './components/docs/ChannelDocs'
import { DocEditor } from './components/docs/DocEditor'
import { CanvasHome } from './components/canvas/CanvasHome'
import { ChannelCanvases } from './components/canvas/ChannelCanvases'
// tldraw is a large dependency; keep it out of the main bundle by loading the
// canvas editor lazily (only fetched when a whiteboard is actually opened).
const CanvasEditor = lazy(() =>
  import('./components/canvas/CanvasEditor').then((m) => ({ default: m.CanvasEditor })),
)

type Boot = 'loading' | 'authed' | 'anon'

export function App() {
  const [boot, setBoot] = useState<Boot>('loading')
  const init = useStore((s) => s.init)
  const logout = useStore((s) => s.logout)
  const token = useStore((s) => s.token)
  const navigate = useNavigate()

  // register the 401 handler once
  useEffect(() => {
    setUnauthorizedHandler(() => {
      logout()
      setBoot('anon')
      navigate('/login', { replace: true })
    })
  }, [logout, navigate])

  // expose router navigation to non-React callers (doc chips + notification deep-links)
  useEffect(() => {
    setDocNavigate(navigate)
    setNotifyNavigate((path) => navigate(path))
  }, [navigate])

  // restore session on load
  useEffect(() => {
    let cancelled = false
    const stored = getToken()
    if (!stored) {
      setBoot('anon')
      return
    }
    api
      .me()
      .then(async (user) => {
        if (cancelled) return
        await init(stored, user)
        if (!cancelled) setBoot('authed')
      })
      .catch(() => {
        if (!cancelled) setBoot('anon')
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // keep boot in sync after login (token set via store.init inside Login)
  useEffect(() => {
    if (token && boot !== 'authed') setBoot('authed')
    if (!token && boot === 'authed') setBoot('anon')
  }, [token, boot])

  if (boot === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--color-ink)]">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 animate-pulse items-center justify-center rounded-xl bg-[var(--color-panel)] text-2xl font-extrabold text-[var(--color-accent)]">
            #
          </div>
          <span className="text-sm text-[var(--color-text-faint)]">Loading…</span>
        </div>
        <Toasts />
      </div>
    )
  }

  const authed = boot === 'authed'

  return (
    <>
      <Routes>
        <Route
          path="/login"
          element={authed ? <Navigate to="/" replace /> : <Login />}
        />
        <Route
          path="/"
          element={authed ? <AppShell /> : <Navigate to="/login" replace />}
        >
          <Route index element={<Home />} />
          <Route path="c/:channelId" element={<MessagePane />} />
          <Route path="search" element={<SearchResults />} />
          <Route path="docs" element={<DocsHome />} />
          <Route path="docs/c/:channelId" element={<ChannelDocs />} />
          <Route path="d/:docId" element={<DocEditor />} />
          <Route path="canvas" element={<CanvasHome />} />
          <Route path="canvas/c/:channelId" element={<ChannelCanvases />} />
          <Route
            path="x/:docId"
            element={
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-faint)]">
                    Loading canvas…
                  </div>
                }
              >
                <CanvasEditor />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  )
}
