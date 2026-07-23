import { effectiveNicknames } from '../lib/displayName'
import { useMemo, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import { useStore, streamChannelShielded } from '../store'
import { channelLabel } from '../lib/util'
import { CreateChannelModal } from './CreateChannelModal'
import { BrowseChannelsModal } from './BrowseChannelsModal'
import { ChannelSettingsModal } from './ChannelSettingsModal'
import { GearIcon, LockIcon } from './icons'
import type { Channel } from '../lib/types'

export function Sidebar({
  variant = 'desktop',
  onToggle,
}: {
  variant?: 'desktop' | 'mobile'
  onToggle?: () => void
}) {
  const channels = useStore((s) => s.channels)
  const nicknames = useStore(effectiveNicknames)
  const online = useStore((s) => s.online)
  const voiceRooms = useStore((s) => s.voiceRooms)
  const setQuickSwitcher = useStore((s) => s.setQuickSwitcher)
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [showBrowse, setShowBrowse] = useState(false)
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
          if (ta === tb) return channelLabel(a, nicknames).localeCompare(channelLabel(b, nicknames))
          return ta < tb ? 1 : -1
        }),
    [channels, nicknames],
  )

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = search.trim()
    if (q) navigate(`/search?q=${encodeURIComponent(q)}`)
  }

  const mobile = variant === 'mobile'

  return (
    <aside
      className={`flex shrink-0 flex-col bg-[var(--color-panel)] ${
        mobile
          ? 'h-full w-full min-w-0 flex-1'
          : 'w-64 border-r border-[var(--color-border)]'
      }`}
    >
      {/* workspace header */}
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-ink)] text-lg font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          #
        </span>
        <span className="text-base font-bold tracking-tight">sharp</span>
        <button
          onClick={() => setQuickSwitcher(true)}
          title="Quick switcher (⌘K)"
          className="ml-auto rounded-md border border-[var(--color-border)] px-2 py-1 text-[10px] font-medium text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
        >
          ⌘K
        </button>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-controls="app-sidebar"
            aria-expanded
            aria-keyshortcuts="\\"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (\)"
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <SidebarToggleIcon open />
          </button>
        )}
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

      <nav className="flex-1 overflow-y-auto px-2 pb-3 pt-4">
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

      {showCreate && <CreateChannelModal onClose={() => setShowCreate(false)} />}
      {showBrowse && <BrowseChannelsModal onClose={() => setShowBrowse(false)} />}
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
  const shielded =
    useStore((s) => streamChannelShielded(s, channel.id)) && channel.kind === 'private'
  return (
    <NavLink
      to={`/c/${channel.id}`}
      className={`group flex min-h-11 items-center gap-1.5 rounded-md px-2 py-2 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : unread
            ? 'text-[var(--color-text)] hover:bg-[var(--color-panel-2)]'
            : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span className="text-[var(--color-text-faint)]">#</span>
      <span className={`min-w-0 flex-1 truncate ${unread && !active ? 'font-semibold' : ''} ${shielded ? 'stream-blur' : ''}`}>
        {channel.name}
      </span>
      {channel.kind === 'private' && (
        <span className="shrink-0 text-[var(--color-text-faint)]" title="Private">
          <LockIcon />
        </span>
      )}
      <VoiceRoomIndicator room={voiceRoom} />
      {/* Hover-revealed on desktop; hidden on mobile — the list stays a clean
          tap target and settings live in the channel header there. */}
      <button
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onSettings()
        }}
        title="Channel settings"
        className="hidden h-8 w-8 shrink-0 items-center justify-center rounded text-[var(--color-text-faint)] opacity-0 hover:text-[var(--color-text)] group-hover:opacity-100 md:flex"
      >
        <GearIcon />
      </button>
      {unread && !active && (
        <span className={`rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white ${shielded ? 'stream-blur' : ''}`}>
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
  const nicknames = useStore(effectiveNicknames)
  const active = channelId === channel.id
  const unread = channel.unread_count > 0
  const shielded = useStore((s) => streamChannelShielded(s, channel.id))
  return (
    <NavLink
      to={`/c/${channel.id}`}
      className={`flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: online ? '#4fbf9f' : '#4b4b56' }}
      />
      <span className={`min-w-0 flex-1 truncate ${unread && !active ? 'font-semibold text-[var(--color-text)]' : ''} ${shielded ? 'stream-blur' : ''}`}>
        {channelLabel(channel, nicknames)}
      </span>
      <VoiceRoomIndicator room={voiceRoom} />
      {unread && !active && (
        <span className={`ml-auto rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white ${shielded ? 'stream-blur' : ''}`}>
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
      className="voice-live-indicator flex shrink-0 items-center gap-1 text-[10px] font-medium tabular-nums text-[var(--color-accent-hover)]"
    >
      <svg className="voice-waveform" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path className="voice-wave-bar" d="M4 10v4" />
        <path className="voice-wave-bar" d="M8 7v10" />
        <path className="voice-wave-bar" d="M12 4v16" />
        <path className="voice-wave-bar" d="M16 8v8" />
        <path className="voice-wave-bar" d="M20 10v4" />
      </svg>
      {count}
    </span>
  )
}

export function SidebarToggleIcon({ open }: { open: boolean }) {
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
