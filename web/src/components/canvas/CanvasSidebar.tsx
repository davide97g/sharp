import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { toastError } from '../../lib/toast'
import type { Channel, Doc } from '../../lib/types'

export function CanvasSidebar() {
  const channels = useStore((s) => s.channels)
  const me = useStore((s) => s.me)
  const logout = useStore((s) => s.logout)
  const location = useLocation()

  const activeCanvasId = location.pathname.match(/^\/x\/([^/]+)/)?.[1] ?? null
  const activeChannelId = useStore((s) =>
    activeCanvasId ? s.docMeta[activeCanvasId]?.channel_id ?? null : null,
  )

  const myChannels = useMemo(
    () =>
      channels
        .filter((c) => c.kind !== 'dm' && c.is_member)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  )

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-ink)] text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <circle cx="17.5" cy="17.5" r="3.5" />
          </svg>
        </span>
        <span className="text-base font-bold tracking-tight">Canvas</span>
      </div>

      <div className="px-3 pt-3">
        <NavLink
          to="/canvas"
          end
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              isActive
                ? 'bg-[var(--color-accent-soft)] text-white'
                : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
            }`
          }
        >
          <span>🏠</span>
          <span className="flex-1">Home</span>
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Channels
        </div>
        <div className="mt-1 space-y-0.5">
          {myChannels.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-[var(--color-text-faint)]">
              Join a channel to start drawing.
            </div>
          )}
          {myChannels.map((c) => (
            <ChannelCanvasGroup
              key={c.id}
              channel={c}
              activeCanvasId={activeCanvasId}
              activeChannel={c.id === activeChannelId}
            />
          ))}
        </div>
      </nav>

      <div className="flex items-center gap-2 border-t border-[var(--color-border)] px-3 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--color-accent)] text-xs font-semibold text-white">
          {(me?.display_name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{me?.display_name}</div>
          <div className="truncate text-[11px] text-[var(--color-text-faint)]">{me?.email}</div>
        </div>
        <button
          onClick={logout}
          title="Sign out"
          className="rounded-md px-2 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          ⎋
        </button>
      </div>
    </aside>
  )
}

function ChannelCanvasGroup({
  channel,
  activeCanvasId,
  activeChannel,
}: {
  channel: Channel
  activeCanvasId: string | null
  activeChannel: boolean
}) {
  const docs = useStore((s) => s.docsByChannel[channel.id])
  const loaded = useStore((s) => s.docsLoaded.has(channel.id))
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const createCanvas = useStore((s) => s.createCanvas)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Canvases share the docs buckets — filter to kind === 'canvas'.
  const canvases = useMemo(() => docs?.filter((d) => d.kind === 'canvas'), [docs])

  // Auto-expand if the active canvas belongs to this channel.
  const hasActive = activeChannel || !!canvases?.some((d) => d.id === activeCanvasId)
  const expanded = open || hasActive

  // Load the active canvas's channel so the sidebar can highlight it.
  useEffect(() => {
    if (activeChannel && !loaded) loadChannelDocs(channel.id)
  }, [activeChannel, loaded, channel.id, loadChannelDocs])

  function toggle() {
    const next = !expanded
    setOpen(next)
    if (next && !loaded) loadChannelDocs(channel.id)
  }

  async function newCanvas(e: React.MouseEvent) {
    e.stopPropagation()
    if (creating) return
    setCreating(true)
    try {
      const canvas = await createCanvas(channel.id)
      setOpen(true)
      navigate(`/x/${canvas.id}`)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div>
      <div className="group flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]">
        <button onClick={toggle} className="flex min-w-0 flex-1 items-center gap-1 text-left">
          <span
            className={`text-[10px] text-[var(--color-text-faint)] transition-transform ${expanded ? 'rotate-90' : ''}`}
          >
            ▶
          </span>
          <span className="text-[var(--color-text-faint)]">#</span>
          <span className="min-w-0 flex-1 truncate">{channel.name}</span>
        </button>
        <button
          onClick={newCanvas}
          disabled={creating}
          title="New canvas"
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-faint)] opacity-0 hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] group-hover:opacity-100"
        >
          +
        </button>
      </div>

      {expanded && (
        <div className="mb-1 ml-4 space-y-0.5 border-l border-[var(--color-border)] pl-1.5">
          {!loaded && !docs && (
            <div className="px-2 py-1 text-xs text-[var(--color-text-faint)]">Loading…</div>
          )}
          {loaded && (canvases?.length ?? 0) === 0 && (
            <button
              onClick={newCanvas}
              className="w-full rounded-md px-2 py-1 text-left text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              No canvases yet — create one
            </button>
          )}
          {canvases?.map((d) => (
            <CanvasRow key={d.id} canvas={d} active={d.id === activeCanvasId} />
          ))}
          <NavLink
            to={`/canvas/c/${channel.id}`}
            className="block rounded-md px-2 py-1 text-[11px] text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text-dim)]"
          >
            All canvases & trash…
          </NavLink>
        </div>
      )}
    </div>
  )
}

function CanvasRow({ canvas, active }: { canvas: Doc; active: boolean }) {
  return (
    <NavLink
      to={`/x/${canvas.id}`}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span className="w-4 shrink-0 text-center text-xs">{canvas.icon || '🎨'}</span>
      <span className="min-w-0 flex-1 truncate">{canvas.title || 'Untitled'}</span>
    </NavLink>
  )
}
