import { useCallback, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { DocsSidebar } from './docs/DocsSidebar'
import { CanvasSidebar } from './canvas/CanvasSidebar'
import { CompactSidebar } from './CompactSidebar'
import { ThreadPanel } from './ThreadPanel'
import { QuickSwitcher } from './QuickSwitcher'
import { SearchPalette } from './SearchPalette'
import { InboxPanel } from './NotificationCenter'
import { VideoStage } from './voice/VideoStage'
import { Onboarding } from './Onboarding'
import { isOnboardingDone } from '../lib/onboarding'
import { useStore } from '../store'

const SIDEBAR_OPEN_KEY = 'sharp.sidebarOpen'

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
  const inVoice = useStore((s) => s.voice.channelId !== null)
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== 'false',
  )
  const [onboarding, setOnboarding] = useState(() => !isOnboardingDone())

  const docsMode =
    location.pathname.startsWith('/docs') || location.pathname.startsWith('/d/')
  const canvasMode =
    location.pathname.startsWith('/canvas') || location.pathname.startsWith('/x/')
  const mode: 'chat' | 'docs' | 'canvas' = canvasMode
    ? 'canvas'
    : docsMode
      ? 'docs'
      : 'chat'

  const setInboxOpen = useStore((s) => s.setInboxOpen)

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

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(sidebarOpen))
  }, [sidebarOpen])

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

      if (e.key === '\\' && !e.repeat && !isEditableTarget(e.target)) {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQuickSwitcher, setSearchOpen, toggleSidebar])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ModeRail
        mode={mode}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
      />
      <div
        id="app-sidebar"
        className="sidebar-shell relative"
        data-open={sidebarOpen}
      >
        {sidebarOpen ? (
          canvasMode ? <CanvasSidebar /> : docsMode ? <DocsSidebar /> : <Sidebar />
        ) : (
          <CompactSidebar mode={mode} />
        )}
      </div>
      <Outlet />
      {mode === 'chat' && <ThreadPanel />}
      {inVoice && <VideoStage />}
      <QuickSwitcher />
      <SearchPalette />
      {mode === 'chat' && <InboxPanel />}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}
    </div>
  )
}

function ModeRail({
  mode,
  sidebarOpen,
  onToggleSidebar,
}: {
  mode: 'chat' | 'docs' | 'canvas'
  sidebarOpen: boolean
  onToggleSidebar: () => void
}) {
  const navigate = useNavigate()
  const chatUnread = useStore((s) => s.notifUnread)
  const mentions = useStore((s) => s.mentions)
  const docMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind !== 'canvas' ? 1 : 0),
    0,
  )
  const canvasMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind === 'canvas' ? 1 : 0),
    0,
  )

  return (
    <nav
      aria-label="Workspace sections"
      className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--color-border)] bg-[var(--color-ink)] py-3"
    >
      <RailButton
        active={mode === 'chat'}
        onClick={() => navigate('/')}
        title="Chat"
        badge={chatUnread}
        label="#"
      />
      <RailButton
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
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-controls="app-sidebar"
        aria-expanded={sidebarOpen}
        aria-keyshortcuts="\\"
        aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        title={`${sidebarOpen ? 'Collapse' : 'Expand'} sidebar (\\)`}
        className="micro-icon-button mt-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-ink)]"
      >
        <span className="micro-icon-glyph"><SidebarToggleIcon open={sidebarOpen} /></span>
      </button>
    </nav>
  )
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M8.5 4v16" />
      <path d={open ? 'm15 9-3 3 3 3' : 'm12 9 3 3-3 3'} />
    </svg>
  )
}

function RailButton({
  active,
  onClick,
  title,
  label,
  badge,
}: {
  active: boolean
  onClick: () => void
  title: string
  label: React.ReactNode
  badge?: number
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`micro-icon-button relative flex h-10 w-10 items-center justify-center rounded-xl text-lg font-extrabold transition ${
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
    </button>
  )
}
