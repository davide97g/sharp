import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { api, getToken, setToken, setUnauthorizedHandler } from './lib/api'
import { setNavigate as setDocNavigate } from './lib/nav'
import { setNavigate as setNotifyNavigate } from './lib/notify'
import { isTauri, registerDeepLinkHandler } from './lib/desktopAuth'
import { toastError } from './lib/toast'
import { useStore } from './store'
import { Login } from './components/Login'
import { GuestCall } from './components/GuestCall'
import { AppShell } from './components/AppShell'
import { Splash } from './components/Splash'
import { MessagePane } from './components/MessagePane'
import { SearchResults } from './components/SearchResults'
import { Home } from './components/Home'
import { Toasts } from './components/Toasts'
import { DocsHome } from './components/docs/DocsHome'
import { ChannelDocs } from './components/docs/ChannelDocs'
import { DocEditor } from './components/docs/DocEditor'
import { CanvasHome } from './components/canvas/CanvasHome'
import { ChannelCanvases } from './components/canvas/ChannelCanvases'
import { BoardHome } from './components/board/BoardHome'
import { ChannelBoards } from './components/board/ChannelBoards'
import { BoardEditor } from './components/board/BoardEditor'
import { TasksHome } from './components/tasks/TasksHome'
import { ProjectView } from './components/tasks/ProjectView'
import { MeetingsHome } from './components/meetings/MeetingsHome'
import { MeetingDetailView } from './components/meetings/MeetingDetailView'
import { CalendarView } from './components/calendar/CalendarView'
import { HelpArea } from './components/help/HelpArea'
import { PasskeySetupPrompt } from './components/PasskeySetupPrompt'
import { UserSettingsPage } from './components/UserSettingsModal'
// tldraw is a large dependency; keep it out of the main bundle by loading the
// canvas editor lazily (only fetched when a whiteboard is actually opened).
const CanvasEditor = lazy(() =>
  import('./components/canvas/CanvasEditor').then((m) => ({ default: m.CanvasEditor })),
)

type Boot = 'loading' | 'authed' | 'anon'

export function App() {
  const [boot, setBoot] = useState<Boot>('loading')
  // brand splash: plays once per page load, over the top of everything, then
  // eases out to reveal whatever the auth gate resolved to.
  const [showSplash, setShowSplash] = useState(true)
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

  // native browser-login: receive the `sharp://auth?...` deep link, exchange the
  // one-time code for a JWT, and sign in (handles both running + cold launch).
  useEffect(() => {
    if (!isTauri) return
    let cleanup: (() => void) | undefined
    registerDeepLinkHandler(
      async (res) => {
        setToken(res.token)
        await init(res.token, res.user)
        setBoot('authed')
        navigate('/', { replace: true })
      },
      () => toastError('Browser sign-in failed. Please try again.'),
    ).then((fn) => {
      cleanup = fn
    })
    return () => cleanup?.()
  }, [init, navigate])

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

  const authed = boot === 'authed'

  return (
    <>
      {/* Routes stay unmounted until the auth gate resolves so a deep link
          (e.g. /c/:id) isn't prematurely redirected to /login while we're
          still deciding. The splash covers this whole window. */}
      {boot !== 'loading' && (
      <Routes>
        <Route
          path="/login"
          element={authed ? <Navigate to="/" replace /> : <Login />}
        />
        {/* Public call link: authenticated visitors keep their account session;
            anonymous visitors get the scoped guest flow. */}
        <Route path="/call/:token" element={<GuestCall />} />
        <Route
          path="/"
          element={authed ? <AppShell /> : <Navigate to="/login" replace />}
        >
          <Route index element={<Home />} />
          <Route path="c/:channelId" element={<MessagePane />} />
          {/* Slack-style in-channel tabs: docs/canvas galleries that stay in
              chat mode (channel sidebar stays put). */}
          <Route path="c/:channelId/docs" element={<ChannelDocs />} />
          <Route path="c/:channelId/canvas" element={<ChannelCanvases />} />
          <Route path="c/:channelId/board" element={<ChannelBoards />} />
          <Route path="search" element={<SearchResults />} />
          <Route path="docs" element={<DocsHome />} />
          <Route path="docs/c/:channelId" element={<ChannelDocs />} />
          <Route path="d/:docId" element={<DocEditor />} />
          <Route path="canvas" element={<CanvasHome />} />
          <Route path="canvas/c/:channelId" element={<ChannelCanvases />} />
          <Route path="board" element={<BoardHome />} />
          <Route path="board/c/:channelId" element={<ChannelBoards />} />
          <Route path="b/:docId" element={<BoardEditor />} />
          <Route path="tasks" element={<TasksHome />} />
          <Route path="t/:key" element={<ProjectView />} />
          <Route path="t/:key/:num" element={<ProjectView />} />
          <Route path="meetings" element={<MeetingsHome />} />
          <Route path="meetings/:meetingId" element={<MeetingDetailView />} />
          <Route path="calendar" element={<CalendarView />} />
          <Route path="calendar/:date" element={<CalendarView />} />
          <Route path="help" element={<HelpArea />} />
          <Route path="help/:tab" element={<HelpArea />} />
          <Route path="settings" element={<Navigate to="/settings/profile" replace />} />
          <Route path="settings/:section" element={<UserSettingsPage />} />
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
      )}
      {showSplash && (
        <Splash ready={boot !== 'loading'} onDone={() => setShowSplash(false)} />
      )}
      {authed && !isTauri && <PasskeySetupPrompt />}
      <Toasts />
    </>
  )
}
