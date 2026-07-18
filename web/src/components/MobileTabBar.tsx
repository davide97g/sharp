import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { hasUnseenRelease } from '../lib/whatsNew'
import { UserSettingsModal } from './UserSettingsModal'

type TabId = 'chat' | 'docs' | 'canvas' | 'more'

function tabFromPath(pathname: string): TabId {
  if (pathname.startsWith('/docs') || pathname.startsWith('/d/')) return 'docs'
  if (pathname.startsWith('/canvas') || pathname.startsWith('/x/')) return 'canvas'
  if (
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
  const [settingsOpen, setSettingsOpen] = useState(false)
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
              label="Meetings"
              onClick={() => {
                setMoreOpen(false)
                navigate('/meetings')
              }}
            />
            <MoreLink
              label="Calendar"
              onClick={() => {
                setMoreOpen(false)
                navigate('/calendar')
              }}
            />
            <MoreLink
              label="Help"
              badge={unseenRelease}
              onClick={() => {
                setMoreOpen(false)
                navigate('/help')
              }}
            />
            <MoreLink
              label="Settings"
              onClick={() => {
                setMoreOpen(false)
                setSettingsOpen(true)
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
      </nav>

      {settingsOpen && <UserSettingsModal onClose={() => setSettingsOpen(false)} />}
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
      className={`relative flex min-h-12 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 px-1 pt-1.5 text-[10px] font-medium outline-none transition-colors active:bg-[var(--color-panel)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
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
}: {
  label: string
  onClick: () => void
  badge?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-12 w-full cursor-pointer items-center justify-between rounded-xl px-3 py-3 text-left text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-panel-2)] active:bg-[var(--color-panel-2)]"
    >
      <span>{label}</span>
      {badge && <span className="h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-hidden />}
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
