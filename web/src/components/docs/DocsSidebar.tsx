import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { toastError } from '../../lib/toast'
import type { Channel, Doc } from '../../lib/types'

export function DocsSidebar() {
  const channels = useStore((s) => s.channels)
  const unreadMentions = useStore((s) => s.unreadMentionCount)
  const navigate = useNavigate()
  const location = useLocation()
  const [search, setSearch] = useState('')

  const activeDocId = location.pathname.match(/^\/d\/([^/]+)/)?.[1] ?? null
  const activeChannelId = useStore((s) =>
    activeDocId ? s.docMeta[activeDocId]?.channel_id ?? null : null,
  )

  const myChannels = useMemo(
    () =>
      channels
        .filter((c) => c.kind !== 'dm' && c.is_member)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels],
  )

  function submitSearch(e: React.FormEvent) {
    e.preventDefault()
    const q = search.trim()
    if (q) navigate(`/search?tab=docs&q=${encodeURIComponent(q)}`)
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-ink)] text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <path d="M14 2v6h6" />
          </svg>
        </span>
        <span className="text-base font-bold tracking-tight">Docs</span>
      </div>

      <form onSubmit={submitSearch} className="px-3 pt-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search docs…"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
      </form>

      <div className="px-3 pt-3">
        <NavLink
          to="/docs"
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
          <span className="flex-1">Home & inbox</span>
          {unreadMentions > 0 && (
            <span className="rounded-full bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-bold text-white">
              {unreadMentions}
            </span>
          )}
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Channels
        </div>
        <div className="mt-1 space-y-0.5">
          {myChannels.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-[var(--color-text-faint)]">
              Join a channel to start writing docs.
            </div>
          )}
          {myChannels.map((c) => (
            <ChannelDocGroup
              key={c.id}
              channel={c}
              activeDocId={activeDocId}
              activeChannel={c.id === activeChannelId}
            />
          ))}
        </div>
      </nav>

    </aside>
  )
}

function ChannelDocGroup({
  channel,
  activeDocId,
  activeChannel,
}: {
  channel: Channel
  activeDocId: string | null
  activeChannel: boolean
}) {
  const docs = useStore((s) => s.docsByChannel[channel.id])
  // Docs view: exclude canvases (kind === 'canvas'), which live under /canvas.
  const docItems = (docs ?? []).filter((d) => d.kind !== 'canvas')
  const loaded = useStore((s) => s.docsLoaded.has(channel.id))
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const createDoc = useStore((s) => s.createDoc)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)

  // Auto-expand if the active doc belongs to this channel.
  const hasActive = activeChannel || !!docs?.some((d) => d.id === activeDocId)
  const expanded = open || hasActive

  // Load the active doc's channel so the sidebar can highlight it.
  useEffect(() => {
    if (activeChannel && !loaded) loadChannelDocs(channel.id)
  }, [activeChannel, loaded, channel.id, loadChannelDocs])

  function toggle() {
    const next = !expanded
    setOpen(next)
    if (next && !loaded) loadChannelDocs(channel.id)
  }

  async function newDoc(e: React.MouseEvent) {
    e.stopPropagation()
    if (creating) return
    setCreating(true)
    try {
      const doc = await createDoc(channel.id)
      setOpen(true)
      navigate(`/d/${doc.id}`)
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
          onClick={newDoc}
          disabled={creating}
          title="New doc"
          className="flex h-8 w-8 items-center justify-center rounded text-[var(--color-text-faint)] opacity-100 hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] md:h-5 md:w-5 md:opacity-0 md:group-hover:opacity-100"
        >
          +
        </button>
      </div>

      {expanded && (
        <div className="mb-1 ml-4 space-y-0.5 border-l border-[var(--color-border)] pl-1.5">
          {!loaded && !docs && (
            <div className="px-2 py-1 text-xs text-[var(--color-text-faint)]">Loading…</div>
          )}
          {loaded && docItems.length === 0 && (
            <button
              onClick={newDoc}
              className="w-full rounded-md px-2 py-1 text-left text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              No docs yet — create one
            </button>
          )}
          {docItems.map((d) => (
            <DocRow key={d.id} doc={d} active={d.id === activeDocId} />
          ))}
          <NavLink
            to={`/docs/c/${channel.id}`}
            className="block rounded-md px-2 py-1 text-[11px] text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text-dim)]"
          >
            All docs & trash…
          </NavLink>
        </div>
      )}
    </div>
  )
}

function DocRow({ doc, active }: { doc: Doc; active: boolean }) {
  return (
    <NavLink
      to={`/d/${doc.id}`}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
        active
          ? 'bg-[var(--color-accent-soft)] text-white'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span className="w-4 shrink-0 text-center text-xs">{doc.icon || '📄'}</span>
      <span className="min-w-0 flex-1 truncate">{doc.title || 'Untitled'}</span>
    </NavLink>
  )
}
