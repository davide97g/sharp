import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { hasUnseenRelease } from '../lib/whatsNew'
import { Avatar } from './Avatar'
import { TasksGlyph } from './tasks/taskUi'

type TabId = 'chat' | 'docs' | 'canvas' | 'more'

function tabFromPath(pathname: string): TabId {
  if (pathname.startsWith('/docs') || pathname.startsWith('/d/')) return 'docs'
  if (pathname.startsWith('/canvas') || pathname.startsWith('/x/')) return 'canvas'
  if (
    pathname.startsWith('/board') ||
    pathname.startsWith('/b/') ||
    pathname.startsWith('/tasks') ||
    pathname.startsWith('/t/') ||
    pathname.startsWith('/sharpy') ||
    pathname.startsWith('/meetings') ||
    pathname.startsWith('/calendar') ||
    pathname.startsWith('/help')
  ) {
    return 'more'
  }
  return 'chat'
}

export function MobileTabBar() {
  const navigate = useNavigate()
  const location = useLocation()
  const active = tabFromPath(location.pathname)
  const [moreOpen, setMoreOpen] = useState(false)
  const [unseenRelease, setUnseenRelease] = useState(hasUnseenRelease)
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
  const boardMentions = mentions.reduce(
    (n, m) => n + (!m.read_at && m.doc.kind === 'board' ? 1 : 0),
    0,
  )
  const me = useStore((s) => s.me)

  useEffect(() => {
    const update = () => setUnseenRelease(hasUnseenRelease())
    window.addEventListener('sharp:last-seen-version', update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener('sharp:last-seen-version', update)
      window.removeEventListener('storage', update)
    }
  }, [])

  // Close the More sheet when navigating away from secondary modes.
  useEffect(() => {
    if (active !== 'more') setMoreOpen(false)
  }, [location.pathname, active])

  function go(tab: TabId) {
    if (tab === 'more') {
      setMoreOpen((open) => !open)
      return
    }
    setMoreOpen(false)
    if (tab === 'chat') navigate('/')
    else if (tab === 'docs') navigate('/docs')
    else navigate('/canvas')
  }

  return (
    <>
      {moreOpen && (
        <div className="fixed inset-0 z-[55]" role="dialog" aria-modal="true" aria-label="More">
          <button
            type="button"
            aria-label="Close"
            className="absolute inset-0 cursor-default bg-black/45"
            onClick={() => setMoreOpen(false)}
          />
          <div
            className="absolute inset-x-0 bottom-[var(--mobile-tab-h)] z-[56] rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-2xl"
            style={{ paddingBottom: '0.75rem' }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-[var(--color-border)]" />
            <MoreLink
              label="Boards"
              icon={<BoardIcon />}
              badge={boardMentions}
              onClick={() => {
                setMoreOpen(false)
                navigate('/board')
              }}
            />
            <MoreLink
              label="Tasks"
              icon={<TasksGlyph size={18} />}
              onClick={() => {
                setMoreOpen(false)
                navigate('/tasks')
              }}
            />
            <MoreLink
              label="Meetings"
              icon={<MeetingsIcon />}
              onClick={() => {
                setMoreOpen(false)
                navigate('/meetings')
              }}
            />
            <MoreLink
              label="Calendar"
              icon={<CalendarIcon />}
              onClick={() => {
                setMoreOpen(false)
                navigate('/calendar')
              }}
            />
            <MoreLink
              label="Sharpy"
              icon={<SharpyIcon />}
              onClick={() => {
                setMoreOpen(false)
                navigate('/sharpy')
              }}
            />
            <MoreLink
              label="Help"
              icon={<HelpIcon />}
              badge={unseenRelease}
              onClick={() => {
                setMoreOpen(false)
                navigate('/help')
              }}
            />
          </div>
        </div>
      )}

      <nav
        aria-label="Workspace sections"
        className="mobile-tab-bar fixed inset-x-0 bottom-0 z-40 flex shrink-0 items-stretch border-t border-[var(--color-border)] bg-[var(--color-ink)]"
      >
        <TabButton
          active={active === 'chat'}
          label="Chat"
          badge={chatUnread}
          onClick={() => go('chat')}
          icon={<span className="text-base font-bold leading-none">#</span>}
        />
        <TabButton
          active={active === 'docs'}
          label="Docs"
          badge={docMentions}
          onClick={() => go('docs')}
          icon={<DocsIcon />}
        />
        <TabButton
          active={active === 'canvas'}
          label="Canvas"
          badge={canvasMentions}
          onClick={() => go('canvas')}
          icon={<CanvasIcon />}
        />
        <TabButton
          active={active === 'more' || moreOpen}
          label="More"
          onClick={() => go('more')}
          icon={<MoreIcon />}
        />
        <TabButton
          active={false}
          label="You"
          onClick={() => {
            setMoreOpen(false)
            navigate('/settings/profile', { state: { from: `${location.pathname}${location.search}` } })
          }}
          icon={me ? <Avatar id={me.id} name={me.display_name} size={24} nicknameCard={false} /> : <ProfileIcon />}
        />
      </nav>
    </>
  )
}

function TabButton({
  active,
  label,
  badge,
  onClick,
  icon,
}: {
  active: boolean
  label: string
  badge?: number
  onClick: () => void
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`relative flex min-h-12 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 px-1 pt-1.5 text-3xs font-medium outline-none transition-colors active:bg-[var(--color-panel)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
        active ? 'text-[var(--color-accent-hover)]' : 'text-[var(--color-text-faint)]'
      }`}
    >
      <span className="relative flex h-6 w-6 items-center justify-center">
        {icon}
        {!!badge && badge > 0 && (
          <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-bold leading-none text-white">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span>{label}</span>
    </button>
  )
}

function MoreLink({
  label,
  onClick,
  badge,
  icon,
}: {
  label: string
  onClick: () => void
  badge?: boolean | number
  icon: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full cursor-pointer items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-panel-2)] active:bg-[var(--color-panel-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <span className="flex items-center gap-3"><span className="text-[var(--color-text-dim)]">{icon}</span>{label}</span>
      {typeof badge === 'number' && badge > 0 ? <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-accent-hover)]">{badge > 99 ? '99+' : badge}</span> : badge ? <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-hidden /> : null}
    </button>
  )
}

function DocsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  )
}

function CanvasIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <circle cx="16.5" cy="7.5" r="3.5" />
      <path d="M7.5 21 3 14h9z" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function BoardIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="11" rx="1" /><rect x="16" y="4" width="4" height="7" rx="1" /></svg> }
function MeetingsIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="18" cy="18" r="3" /></svg> }
function CalendarIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg> }
function SharpyIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3c.4 4.7 2.3 6.6 7 7-4.7.4-6.6 2.3-7 7-.4-4.7-2.3-6.6-7-7 4.7-.4 6.6-2.3 7-7Z" /><path d="M18.5 16.5c.1 1.5.8 2.2 2.3 2.3-1.5.1-2.2.8-2.3 2.3-.1-1.5-.8-2.2-2.3-2.3 1.5-.1 2.2-.8 2.3-2.3Z" /></svg> }
function HelpIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.4 2.4 0 1 1 3.8 2c-1 .7-1.5 1.1-1.5 2.2" /><path d="M12 17h.01" /></svg> }

function ProfileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="8" r="3" />
      <path d="M5 21a7 7 0 0 1 14 0" />
    </svg>
  )
}
