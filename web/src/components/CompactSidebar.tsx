import { useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useStore } from '../store'
import { channelLabel } from '../lib/util'
import { Avatar } from './Avatar'
import { UserSettingsModal } from './UserSettingsModal'
import type { Channel } from '../lib/types'

type Mode = 'chat' | 'docs' | 'canvas'

export function CompactSidebar({ mode }: { mode: Mode }) {
  const channels = useStore((s) => s.channels)
  const online = useStore((s) => s.online)
  const me = useStore((s) => s.me)
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const location = useLocation()
  const [showSettings, setShowSettings] = useState(false)

  const activeContentId =
    location.pathname.match(/^\/(?:d|x)\/([^/]+)/)?.[1] ?? null
  const activeContentChannel = useStore((s) =>
    activeContentId ? s.docMeta[activeContentId]?.channel_id ?? null : null,
  )
  const activeChannelId =
    location.pathname.match(/^\/c\/([^/]+)/)?.[1] ??
    location.pathname.match(/^\/(?:docs|canvas)\/c\/([^/]+)/)?.[1] ??
    activeContentChannel

  const myChannels = useMemo(
    () =>
      channels
        .filter((channel) => channel.kind !== 'dm' && channel.is_member)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  )
  const dms = useMemo(
    () =>
      channels
        .filter((channel) => channel.kind === 'dm')
        .sort((a, b) => {
          const aTime = a.last_message_at ?? ''
          const bTime = b.last_message_at ?? ''
          if (aTime === bTime) return channelLabel(a).localeCompare(channelLabel(b))
          return aTime < bTime ? 1 : -1
        }),
    [channels],
  )

  return (
    <aside className="flex h-full w-[4.5rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 shrink-0 items-center justify-center border-b border-[var(--color-border)]">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--color-ink)] font-bold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          <ModeIcon mode={mode} />
        </span>
      </div>

      <nav
        aria-label={`${mode === 'chat' ? 'Chat' : mode === 'docs' ? 'Docs' : 'Canvas'} sidebar`}
        className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto px-2 py-3"
      >
        <button
          type="button"
          onClick={() => setQuickSwitcher(true)}
          aria-label="Quick switcher"
          title="Quick switcher (⌘K)"
          className="micro-icon-button flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <span className="micro-icon-glyph"><SearchIcon /></span>
        </button>

        {mode !== 'chat' && (
          <CompactLink
            to={mode === 'docs' ? '/docs' : '/canvas'}
            label={`${mode === 'docs' ? 'Docs' : 'Canvas'} home`}
            active={
              location.pathname === (mode === 'docs' ? '/docs' : '/canvas')
            }
          >
            <HomeIcon />
          </CompactLink>
        )}

        <div className="my-2 h-px w-8 shrink-0 bg-[var(--color-border)]" />

        {myChannels.map((channel) => (
          <CompactChannelLink
            key={channel.id}
            channel={channel}
            mode={mode}
            active={channel.id === activeChannelId}
          />
        ))}

        {mode === 'chat' && dms.length > 0 && (
          <div className="my-2 h-px w-8 shrink-0 bg-[var(--color-border)]" />
        )}

        {mode === 'chat' &&
          dms.map((channel) => (
            <CompactDmLink
              key={channel.id}
              channel={channel}
              active={channel.id === activeChannelId}
              online={channel.dm_user ? online.has(channel.dm_user.id) : false}
            />
          ))}
      </nav>

      <div className="flex shrink-0 justify-center border-t border-[var(--color-border)] py-3">
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          aria-label={me ? `Open settings for ${me.display_name}` : 'Open settings'}
          title={me?.display_name ?? 'Settings'}
          className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {me && <Avatar id={me.id} name={me.display_name} size={34} />}
        </button>
      </div>

      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
    </aside>
  )
}

function CompactChannelLink({
  channel,
  mode,
  active,
}: {
  channel: Channel
  mode: Mode
  active: boolean
}) {
  const to =
    mode === 'chat'
      ? `/c/${channel.id}`
      : mode === 'docs'
        ? `/docs/c/${channel.id}`
        : `/canvas/c/${channel.id}`
  const unread = channel.unread_count > 0

  return (
    <CompactLink
      to={to}
      label={`#${channel.name}`}
      active={active}
      badge={unread ? channel.unread_count : undefined}
    >
      <span className="text-[11px] font-bold tracking-tight">
        #{channel.name.slice(0, 1).toLowerCase()}
      </span>
    </CompactLink>
  )
}

function CompactDmLink({
  channel,
  active,
  online,
}: {
  channel: Channel
  active: boolean
  online: boolean
}) {
  const user = channel.dm_user
  if (!user) return null
  const label = channelLabel(channel)

  return (
    <NavLink
      to={`/c/${channel.id}`}
      aria-label={label}
      title={label}
      className={`micro-icon-button relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
          : 'hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <Avatar id={user.id} name={user.display_name} size={32} online={online} />
      {channel.unread_count > 0 && <UnreadBadge count={channel.unread_count} />}
    </NavLink>
  )
}

function CompactLink({
  to,
  label,
  active,
  badge,
  children,
}: {
  to: string
  label: string
  active: boolean
  badge?: number
  children: React.ReactNode
}) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      title={label}
      className={`micro-icon-button relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white ring-1 ring-[var(--color-accent)]'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
      }`}
    >
      <span className="micro-icon-glyph flex items-center justify-center">{children}</span>
      {badge !== undefined && badge > 0 && <UnreadBadge count={badge} />}
    </NavLink>
  )
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-bold leading-none text-white ring-2 ring-[var(--color-panel)]">
      {count > 9 ? '9+' : count}
    </span>
  )
}

function ModeIcon({ mode }: { mode: Mode }) {
  if (mode === 'chat') return <span className="text-lg font-extrabold">#</span>
  if (mode === 'docs') {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <circle cx="16.5" cy="7.5" r="3.5" />
      <path d="M7.5 21 3 14h9z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10" />
      <path d="M9 20v-6h6v6" />
    </svg>
  )
}
