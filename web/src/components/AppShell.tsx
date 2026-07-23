import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TasksGlyph } from './tasks/taskUi'
import { CompactSidebar } from './CompactSidebar'
import { ThreadPanel } from './ThreadPanel'
import { SharpyPanel } from './SharpyPanel'
import { QuickSwitcher } from './QuickSwitcher'
import { SearchPalette } from './SearchPalette'
import { InboxPanel } from './NotificationCenter'
import { VideoStage } from './voice/VideoStage'
import { Onboarding } from './Onboarding'
import { MobileTabBar } from './MobileTabBar'
import { isOnboardingDone } from '../lib/onboarding'
import { sound } from '../lib/sound'
import { hasUnseenRelease } from '../lib/whatsNew'
import { useIsMobile } from '../lib/useMediaQuery'
import { useStore } from '../store'
import { RestoreEncryptionModal } from './RestoreEncryptionModal'
import { Avatar } from './Avatar'

const SIDEBAR_OPEN_KEY = 'sharp.sidebarOpen'

// Module jump targets (chord+1…9), in the rail's visual order.
const MODE_ROUTES = ['/', '/docs', '/canvas', '/board', '/tasks', '/meetings', '/calendar', '/help', '/sharpy']

// Browsers reserve ⌘/Ctrl+digit for tab switching, so the chord adapts:
// desktop app (no browser chrome) gets the native ⌘/Ctrl+digit, Mac browsers
// get ⌃digit, and other browsers get Alt+digit.
const isMac = navigator.platform.toUpperCase().includes('MAC')
const isTauri = '__TAURI_INTERNALS__' in window
export const modeChordLabel = isTauri ? (isMac ? '⌘' : 'Ctrl+') : isMac ? '⌃' : 'Alt+'

function chord(digit: number): string {
  return `${modeChordLabel}${digit}`
}

function modeChordPressed(e: KeyboardEvent): boolean {
  if (e.shiftKey) return false
  if (isTauri) return (e.metaKey || e.ctrlKey) && !e.altKey
  if (isMac) return e.ctrlKey && !e.metaKey && !e.altKey
  return e.altKey && !e.metaKey && !e.ctrlKey
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable="true"]') !== null)
  )
}

export function AppShell() {
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const setSearchOpen = useStore((s) => s.setSearchOpen)
  const channels = useStore((s) => s.channels)
  const railPosition = useStore((s) => s.railPosition)
  const dockAutoHide = useStore((s) => s.dockAutoHide)
  const inVoice = useStore((s) => s.voice.channelId !== null)
  const location = useLocation()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false',
  )
  const [onboarding, setOnboarding] = useState(() => !isOnboardingDone())

  const docsMode =
    location.pathname.startsWith('/docs') || location.pathname.startsWith('/d/')
  const canvasMode =
    location.pathname.startsWith('/canvas') || location.pathname.startsWith('/x/')
  const boardMode =
    location.pathname.startsWith('/board') || location.pathname.startsWith('/b/')
  const tasksMode =
    location.pathname.startsWith('/tasks') || location.pathname.startsWith('/t/')
  const meetingsMode = location.pathname.startsWith('/meetings')
  const calendarMode = location.pathname.startsWith('/calendar')
  const sharpyMode = location.pathname.startsWith('/sharpy')
  const helpMode = location.pathname.startsWith('/help')
  const settingsMode = location.pathname.startsWith('/settings')
  const mode: 'chat' | 'docs' | 'canvas' | 'board' | 'tasks' | 'meetings' | 'calendar' | 'sharpy' | 'help' =
    helpMode
      ? 'help'
      : calendarMode
        ? 'calendar'
        : sharpyMode
          ? 'sharpy'
        : meetingsMode
          ? 'meetings'
          : tasksMode
            ? 'tasks'
            : boardMode
              ? 'board'
              : canvasMode
                ? 'canvas'
                : docsMode
                  ? 'docs'
                  : 'chat'

  // On mobile, hide the bottom tab bar while a conversation is open (`/c/…`) so
  // the composer + safe area own the bottom edge — WhatsApp/Slack pattern. The
  // top back button and channel tabs already carry navigation in that view.
  const inChatDetail = /^\/c\//.test(location.pathname)
  const showMobileTabBar = isMobile && !settingsMode && !inChatDetail

  const setInboxOpen = useStore((s) => s.setInboxOpen)
  const dockEdge: 'bottom' | 'top' | null =
    railPosition === 'bottom' ? 'bottom' : railPosition === 'top' ? 'top' : null
  const dockRail = !isMobile && !settingsMode && dockEdge !== null

  // Auto-hidden dock: slides away until the cursor nears the bottom edge (or
  // focus moves into it). A short delay keeps it from flickering on exit.
  const [dockShown, setDockShown] = useState(true)
  const dockHideTimer = useRef<number | null>(null)
  useEffect(() => {
    setDockShown(!dockAutoHide)
    return () => {
      if (dockHideTimer.current !== null) window.clearTimeout(dockHideTimer.current)
    }
  }, [dockAutoHide, dockRail])
  const showDock = useCallback(() => {
    if (dockHideTimer.current !== null) {
      window.clearTimeout(dockHideTimer.current)
      dockHideTimer.current = null
    }
    setDockShown(true)
  }, [])
  const scheduleDockHide = useCallback(() => {
    if (!dockAutoHide) return
    if (dockHideTimer.current !== null) window.clearTimeout(dockHideTimer.current)
    // Near-immediate: just enough slack to cross the gap between the reveal
    // strip and the dock without flicker.
    dockHideTimer.current = window.setTimeout(() => setDockShown(false), 150)
  }, [dockAutoHide])

  // Navigation cues: a mid tick when the mode rail switches (chat/docs/canvas),
  // a near-subliminal tick when moving between channels/docs within a mode. The
  // initial mount is skipped so landing in the app is silent.
  const navRef = useRef<{ mode: string; path: string } | null>(null)
  useEffect(() => {
    const prev = navRef.current
    navRef.current = { mode, path: location.pathname }
    if (!prev) return
    if (prev.mode !== mode) sound.modeSwitch()
    else if (prev.path !== location.pathname) sound.tabSwitch()
  }, [mode, location.pathname])

  // Close the chat inbox when leaving chat mode so it doesn't snap back open.
  useEffect(() => {
    if (mode !== 'chat') setInboxOpen(false)
  }, [mode, setInboxOpen])

  // total unread -> document title
  const totalUnread = channels.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) sharp` : 'sharp'
  }, [totalUnread])

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((open) => !open)
  }, [])

  // Persist desktop sidebar preference only; mobile always uses list→detail.
  useEffect(() => {
    if (isMobile) return
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen))
  }, [sidebarOpen, isMobile])

  // Global shortcuts: ⌘K / Ctrl+K for quick switcher, \ for the sidebar.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickSwitcher(true)
        return
      }

      // ⌘/Ctrl+F: text search palette (intentionally overrides browser find).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
        return
      }

      // Chord+1…9: jump between modules in rail order. e.code keeps digits
      // stable when Option+digit types a symbol on macOS layouts.
      if (!isMobile && modeChordPressed(e) && e.code.startsWith('Digit')) {
        const digit = Number(e.code.slice(5))
        if (digit >= 1 && digit <= MODE_ROUTES.length) {
          e.preventDefault()
          navigate(MODE_ROUTES[digit - 1])
          return
        }
      }

      if (e.key === '\\' && !e.repeat && !isEditableTarget(e.target) && !isMobile && mode === 'chat') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQuickSwitcher, setSearchOpen, toggleSidebar, isMobile, mode, navigate])

  return (
    <div className={`relative flex h-full w-full overflow-hidden ${isMobile ? 'flex-col' : ''}`}>
      {!settingsMode && !isMobile && !dockRail && (
        <ModeRail mode={mode} orientation="vertical" />
      )}
      <div className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${showMobileTabBar ? 'mobile-main' : ''}`}>
        {!settingsMode && !isMobile && mode === 'chat' && (
          <div
            id="app-sidebar"
            className="sidebar-shell relative"
            data-open={sidebarOpen}
          >
            {sidebarOpen ? (
              <Sidebar onToggle={toggleSidebar} />
            ) : (
              <CompactSidebar onToggle={toggleSidebar} />
            )}
          </div>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          <Outlet />
          {!settingsMode && mode === 'chat' && <ThreadPanel />}
          <SharpyPanel />
        </div>
      </div>
      {!settingsMode && !isMobile && dockEdge && (
        <div
          className={`pointer-events-none absolute inset-x-0 z-40 ${
            dockEdge === 'top' ? 'top-0' : 'bottom-0'
          }`}
        >
          {dockAutoHide && (
            <div
              aria-hidden
              onMouseEnter={showDock}
              onMouseLeave={scheduleDockHide}
              className={`pointer-events-auto absolute inset-x-0 h-2 ${
                dockEdge === 'top' ? 'top-0' : 'bottom-0'
              }`}
            />
          )}
          {dockEdge === 'top' && dockAutoHide && (
            <div
              data-shown={dockShown}
              onMouseEnter={showDock}
              onMouseLeave={scheduleDockHide}
              className="dock-notch pointer-events-auto absolute left-1/2 top-0 flex items-center rounded-b-xl border border-t-0 border-[var(--color-border)] bg-[var(--color-ink)] px-2.5 pb-1 pt-0.5"
            >
              <span className="flex h-4.5 w-4.5 items-center justify-center text-[13px] font-extrabold text-[var(--color-accent)]">
                #
              </span>
            </div>
          )}
          <div
            onMouseEnter={showDock}
            onMouseLeave={scheduleDockHide}
            onFocusCapture={showDock}
            data-shown={dockShown}
            data-edge={dockEdge}
            className={`dock-float pointer-events-auto mx-auto w-fit ${
              dockEdge === 'top' ? 'mt-2' : 'mb-2'
            }`}
          >
            <ModeRail mode={mode} orientation="horizontal" edge={dockEdge} />
          </div>
        </div>
      )}
      {showMobileTabBar && <MobileTabBar />}
      {inVoice && <VideoStage />}
      <QuickSwitcher />
      <SearchPalette />
      {!settingsMode && mode === 'chat' && <InboxPanel />}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}
      <RestoreEncryptionModal />
    </div>
  )
}

function ModeRail({
  mode,
  orientation,
  edge = 'bottom',
}: {
  mode: 'chat' | 'docs' | 'canvas' | 'board' | 'tasks' | 'meetings' | 'calendar' | 'sharpy' | 'help'
  orientation: 'vertical' | 'horizontal'
  edge?: 'bottom' | 'top'
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const [unseenRelease, setUnseenRelease] = useState(hasUnseenRelease)
  const chatUnread = useStore((s) => s.notifUnread)
  const mentions = useStore((s) => s.mentions)
  const me = useStore((s) => s.me)
  const docMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind === 'doc' ? 1 : 0),
    0,
  )
  const canvasMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind === 'canvas' ? 1 : 0),
    0,
  )
  const boardMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind === 'board' ? 1 : 0),
    0,
  )

  useEffect(() => {
    const update = () => setUnseenRelease(hasUnseenRelease())
    window.addEventListener('sharp:last-seen-version', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('sharp:last-seen-version', update)
      window.removeEventListener('storage', update)
    }
  }, [])

  // Docked (horizontal) items get instant styled tooltips instead of the
  // browser's delayed native ones; labels flip to the free side of the dock.
  const tip = orientation === 'horizontal' ? (edge === 'top' ? 'below' : 'above') : undefined

  return (
    <nav
      aria-label="Workspace sections"
      data-orientation={orientation}
      data-edge={orientation === 'horizontal' ? edge : undefined}
      className={`mode-rail flex shrink-0 items-center gap-2 ${
        orientation === 'vertical'
          ? 'w-14 flex-col border-r border-[var(--color-border)] bg-[var(--color-ink)] py-3'
          : 'h-14 flex-row justify-center rounded-2xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_72%,transparent)] px-2 pb-1 pt-1 shadow-[0_10px_28px_rgba(0,0,0,0.4)] backdrop-blur-md'
      }`}
    >
      <RailButton
        tip={tip}
        shortcut={chord(1)}
        active={mode === 'chat'}
        onClick={() => navigate('/')}
        title="Chat"
        badge={chatUnread}
        label="#"
      />
      <RailButton
        tip={tip}
        shortcut={chord(2)}
        active={mode === 'docs'}
        onClick={() => navigate('/docs')}
        title="Docs"
        badge={docMentions}
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M8 13h8" />
            <path d="M8 17h6" />
          </svg>
        }
      />
      <RailButton
        tip={tip}
        shortcut={chord(3)}
        active={mode === 'canvas'}
        onClick={() => navigate('/canvas')}
        title="Canvas"
        badge={canvasMentions}
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="4" y="4" width="7" height="7" rx="1" />
            <circle cx="16.5" cy="7.5" r="3.5" />
            <path d="M7.5 21 3 14h9z" />
          </svg>
        }
      />
      <RailButton
        tip={tip}
        shortcut={chord(4)}
        active={mode === 'board'}
        onClick={() => navigate('/board')}
        title="Board"
        badge={boardMentions}
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="4" y="4" width="4" height="16" rx="1" />
            <rect x="10" y="4" width="4" height="11" rx="1" />
            <rect x="16" y="4" width="4" height="7" rx="1" />
          </svg>
        }
      />
      <RailButton
        tip={tip}
        shortcut={chord(5)}
        active={mode === 'tasks'}
        onClick={() => navigate('/tasks')}
        title="Tasks"
        label={<TasksGlyph size={18} />}
      />
      <RailButton
        tip={tip}
        shortcut={chord(6)}
        active={mode === 'meetings'}
        onClick={() => navigate('/meetings')}
        title="Meetings"
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 6h16M4 12h16M4 18h10" />
            <circle cx="18" cy="18" r="3" />
          </svg>
        }
      />
      <RailButton
        tip={tip}
        shortcut={chord(7)}
        active={mode === 'calendar'}
        onClick={() => navigate('/calendar')}
        title="Calendar"
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="M3 9h18M8 2v4M16 2v4" />
          </svg>
        }
      />
      <RailButton
        tip={tip}
        shortcut={chord(8)}
        active={mode === 'help'}
        onClick={() => navigate('/help')}
        title="Help"
        dot={unseenRelease}
        label={
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M9.7 9a2.4 2.4 0 1 1 3.8 2c-1 .7-1.5 1.1-1.5 2.2" />
            <path d="M12 17h.01" />
          </svg>
        }
      />
      {/* Always visible: when the server has no AI configured, /sharpy explains
          how to enable it instead of the destination silently vanishing. */}
      <RailButton
          tip={tip}
        shortcut={chord(9)}
          active={mode === 'sharpy'}
          onClick={() => navigate('/sharpy')}
          title="Sharpy"
          label={
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 3c.4 4.7 2.3 6.6 7 7-4.7.4-6.6 2.3-7 7-.4-4.7-2.3-6.6-7-7 4.7-.4 6.6-2.3 7-7Z" />
              <path d="M18.5 16.5c.1 1.5.8 2.2 2.3 2.3-1.5.1-2.2.8-2.3 2.3-.1-1.5-.8-2.2-2.3-2.3 1.5-.1 2.2-.8 2.3-2.3Z" />
            </svg>
          }
        />
      {me ? (
          <button
            type="button"
            onClick={() => navigate('/settings/profile', { state: { from: `${location.pathname}${location.search}` } })}
            aria-label={`Open settings for ${me.display_name}`}
            title={tip ? undefined : me.display_name}
            data-tooltip={tip ? me.display_name : undefined}
            data-tip={tip}
            className={`mode-rail-control flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl outline-none transition-colors hover:bg-[var(--color-panel)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-ink)] ${orientation === 'vertical' ? 'mt-auto' : ''}`}
          >
            <Avatar id={me.id} name={me.display_name} size={32} nicknameCard={false} />
          </button>
      ) : null}
    </nav>
  )
}

function RailButton({
  active,
  onClick,
  title,
  label,
  badge,
  dot,
  tip,
  shortcut,
}: {
  active: boolean
  onClick: () => void
  title: string
  label: React.ReactNode
  badge?: number
  dot?: boolean
  tip?: 'above' | 'below'
  shortcut?: string
}) {
  const hint = shortcut ? `${title}  ${shortcut}` : title
  return (
    <button
      onClick={onClick}
      title={tip ? undefined : shortcut ? `${title} (${shortcut})` : title}
      data-tooltip={tip ? hint : undefined}
      data-tip={tip}
      className={`mode-rail-control micro-icon-button relative flex h-11 w-11 items-center justify-center rounded-xl text-lg font-extrabold transition ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]'
          : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
      }`}
    >
      <span className="micro-icon-glyph flex items-center justify-center">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {dot && !(badge !== undefined && badge > 0) && (
        <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-ink)] bg-[var(--color-accent)]" />
      )}
    </button>
  )
}
