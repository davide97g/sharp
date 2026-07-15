import { useMemo, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store'
import { channelLabel } from '../lib/util'
import { CreateChannelModal } from './CreateChannelModal'
import { BrowseChannelsModal } from './BrowseChannelsModal'
import { ChannelSettingsModal } from './ChannelSettingsModal'
import { NotificationCenter } from './NotificationCenter'
import { UserSettingsModal } from './UserSettingsModal'
import { Avatar } from './Avatar'
import type { Channel } from '../lib/types'

export function Sidebar() {
  const channels = useStore((s) => s.channels)
  const online = useStore((s) => s.online)
  const voiceRooms = useStore((s) => s.voiceRooms)
  const me = useStore((s) => s.me)
  const logout = useStore((s) => s.logout)
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [showBrowse, setShowBrowse] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const myChannels = useMemo(
    () =>
      channels
        .filter((c) => c.kind !== 'dm' && c.is_member)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  )
  const dms = useMemo(
    () =>
      channels
        .filter((c) => c.kind === 'dm')
        .sort((a, b) => {
          const ta = a.last_message_at ?? ''
          const tb = b.last_message_at ?? ''
          if (ta === tb) return channelLabel(a).localeCompare(channelLabel(b))
          return ta < tb ? 1 : -1
        }),
    [channels],
  )

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = search.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      {/* workspace header */}
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-ink)] text-lg font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          #
        </span>
        <span className="text-base font-bold tracking-tight">sharp</span>
        <div className="ml-auto flex items-center gap-1">
          <NotificationCenter />
          <button
            onClick={() => setQuickSwitcher(true)}
            title="Quick switcher (⌘K)"
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
          >
            ⌘K
          </button>
        </div>
      </div>

      {/* search */}
      <form onSubmit={submitSearch} className="px-3 pt-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages…"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
      </form>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {/* channels */}
        <SectionHeader label="Channels">
          <IconButton title="Browse channels" onClick={() => setShowBrowse(true)}>
            ⌕
          </IconButton>
          <IconButton title="Create channel" onClick={() => setShowCreate(true)}>
            +
          </IconButton>
        </SectionHeader>
        <div className="mb-4 mt-1 space-y-0.5">
          {myChannels.length === 0 && (
            <button
              onClick={() => setShowBrowse(true)}
              className="w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              Browse channels to join…
            </button>
          )}
          {myChannels.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              voiceRoom={voiceRooms[c.id]}
              onSettings={() => setSettingsFor(c.id)}
            />
          ))}
        </div>

        {/* DMs */}
        <SectionHeader label="Direct messages">
          <IconButton title="New message" onClick={() => setQuickSwitcher(true)}>
            +
          </IconButton>
        </SectionHeader>
        <div className="mt-1 space-y-0.5">
          {dms.length === 0 && (
            <button
              onClick={() => setQuickSwitcher(true)}
              className="w-full rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              Message someone…
            </button>
          )}
          {dms.map((c) => (
            <DmRow
              key={c.id}
              channel={c}
              online={c.dm_user ? online.has(c.dm_user.id) : false}
              voiceRoom={voiceRooms[c.id]}
            />
          ))}
        </div>
      </nav>

      {/* footer */}
      <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-3">
        <button
          onClick={() => setShowSettings(true)}
          title="Settings"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--color-panel-2)]"
        >
          {me && <Avatar id={me.id} name={me.display_name} size={28} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{me?.display_name}</div>
            <div className="truncate text-[11px] text-[var(--color-text-faint)]">{me?.email}</div>
          </div>
        </button>
        <button
          onClick={logout}
          title="Sign out"
          className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          ⎋
        </button>
      </div>

      {showCreate && <CreateChannelModal onClose={() => setShowCreate(false)} />}
      {showBrowse && <BrowseChannelsModal onClose={() => setShowBrowse(false)} />}
      {showSettings && <UserSettingsModal onClose={() => setShowSettings(false)} />}
      {settingsFor && (
        <ChannelSettingsModal
          channelId={settingsFor}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </aside>
  )
}

function SectionHeader({
  label,
  children,
}: {
  label: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        {label}
      </span>
      <div className="flex items-center gap-0.5">{children}</div>
    </div>
  )
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  )
}

function ChannelRow({
  channel,
  voiceRoom,
  onSettings,
}: {
  channel: Channel
  voiceRoom?: VoiceRoom
  onSettings: () => void
}) {
  const { channelId } = useParams()
  const active = channelId === channel.id
  const unread = channel.unread_count > 0
  return (
    <NavLink
      to={`/c/${channel.id}`}
      className={`group flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : unread
            ? 'text-[var(--color-text)] hover:bg-[var(--color-panel-2)]'
            : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span className="text-[var(--color-text-faint)]">#</span>
      <span className={`min-w-0 flex-1 truncate ${unread && !active ? 'font-semibold' : ''}`}>
        {channel.name}
      </span>
      {channel.kind === 'private' && <span className="text-xs opacity-60">🔒</span>}
      <VoiceRoomIndicator room={voiceRoom} />
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSettings()
        }}
        title="Channel settings"
        className="hidden shrink-0 rounded px-1 text-[var(--color-text-faint)] hover:text-[var(--color-text)] group-hover:block"
      >
        ⚙
      </button>
      {unread && !active && (
        <span className="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white">
          {channel.unread_count}
        </span>
      )}
    </NavLink>
  )
}

function DmRow({
  channel,
  online,
  voiceRoom,
}: {
  channel: Channel
  online: boolean
  voiceRoom?: VoiceRoom
}) {
  const { channelId } = useParams()
  const active = channelId === channel.id
  const unread = channel.unread_count > 0
  return (
    <NavLink
      to={`/c/${channel.id}`}
      className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: online ? '#4fbf9f' : '#4b4b56' }}
      />
      <span className={`min-w-0 flex-1 truncate ${unread && !active ? 'font-semibold text-[var(--color-text)]' : ''}`}>
        {channelLabel(channel)}
      </span>
      <VoiceRoomIndicator room={voiceRoom} />
      {unread && !active && (
        <span className="ml-auto rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white">
          {channel.unread_count}
        </span>
      )}
    </NavLink>
  )
}

type VoiceRoom = Record<string, { user_id: string; muted: boolean }>

function VoiceRoomIndicator({ room }: { room?: VoiceRoom }) {
  if (!room) return null
  const count = new Set(Object.values(room).map((participant) => participant.user_id)).size
  if (count === 0) return null
  return (
    <span
      aria-label={`${count} ${count === 1 ? 'participant' : 'participants'} in voice`}
      title={`${count} in voice`}
      className="flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums text-[var(--color-accent-hover)]"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 10v4" />
        <path d="M8 7v10" />
        <path d="M12 4v16" />
        <path d="M16 8v8" />
        <path d="M20 10v4" />
      </svg>
      {count}
    </span>
  )
}
