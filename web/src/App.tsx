import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api, getToken, setUnauthorizedHandler } from './lib/api'
import { setNavigate } from './lib/notify'
import { useStore } from './store'
import { Login } from './components/Login'
import { AppShell } from './components/AppShell'
import { MessagePane } from './components/MessagePane'
import { SearchResults } from './components/SearchResults'
import { Home } from './components/Home'
import { Toasts } from './components/Toasts'

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

  // let notification clicks deep-link into channels
  useEffect(() => {
    setNavigate((path) => navigate(path))
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
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  )
}
