import { useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { DocsSidebar } from './docs/DocsSidebar'
import { CanvasSidebar } from './canvas/CanvasSidebar'
import { ThreadPanel } from './ThreadPanel'
import { QuickSwitcher } from './QuickSwitcher'
import { useStore } from '../store'

export function AppShell() {
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const channels = useStore((s) => s.channels)
  const location = useLocation()

  const docsMode =
    location.pathname.startsWith('/docs') || location.pathname.startsWith('/d/')
  const canvasMode =
    location.pathname.startsWith('/canvas') || location.pathname.startsWith('/x/')
  const mode: 'chat' | 'docs' | 'canvas' = canvasMode
    ? 'canvas'
    : docsMode
      ? 'docs'
      : 'chat'

  // total unread -> document title
  const totalUnread = channels.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) sharp` : 'sharp'
  }, [totalUnread])

  // ⌘K / Ctrl+K quick switcher
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickSwitcher(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setQuickSwitcher])

  return (
    <div className="flex h-full w-full overflow-hidden">
      <ModeRail mode={mode} />
      {canvasMode ? <CanvasSidebar /> : docsMode ? <DocsSidebar /> : <Sidebar />}
      <Outlet />
      {mode === 'chat' && <ThreadPanel />}
      <QuickSwitcher />
    </div>
  )
}

function ModeRail({ mode }: { mode: 'chat' | 'docs' | 'canvas' }) {
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
    <nav className="flex w-14 shrink-0 flex-col items-center gap-2 border-r border-[var(--color-border)] bg-[var(--color-ink)] py-3">
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
    </nav>
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
      className={`relative flex h-10 w-10 items-center justify-center rounded-xl text-lg font-extrabold transition ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]'
          : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
      }`}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-white">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}
