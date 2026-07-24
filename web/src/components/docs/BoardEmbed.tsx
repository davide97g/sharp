import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { ApiRequestError, api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { navigateTo } from '../../lib/nav'
import type { DocConnStatus } from '../../lib/docSync'
import { BoardEditorInner } from '../board/BoardEditorInner'

// BlockNote block-render components live outside the app's React context tree,
// so the host DocEditorInner publishes the ambient doc context (channel, viewer
// identity, whether the host doc is editable) through this context. BoardEmbed
// consumes it.
export type DocEmbedContextValue = {
  channelId: string
  user: { name: string; color: string }
  hostEditable: boolean
}

export const DocEmbedContext = createContext<DocEmbedContextValue | null>(null)

const noop = () => {}

type BoardRow = { id: string; title: string; icon: string; channelName?: string }

export function BoardEmbed({
  docId,
  onBind,
  onRemove,
}: {
  docId: string
  onBind: (docId: string) => void
  onRemove: () => void
}) {
  const ctx = useContext(DocEmbedContext)
  // No context means the schema is mounted outside a DocEditorInner (shouldn't
  // happen in practice) — render nothing rather than crash.
  if (!ctx) return null

  return (
    <EventIsland>
      {docId ? (
        <BoundBoard ctx={ctx} docId={docId} onRemove={onRemove} />
      ) : (
        <BoardPicker ctx={ctx} onBind={onBind} onRemove={onRemove} />
      )}
    </EventIsland>
  )
}

// Non-editable island: keeps ProseMirror from treating clicks/selection inside
// the block as document edits. Events must still bubble to the React root so
// the board's own React handlers (composer Enter, panel Esc, DnD) keep working.
function EventIsland({ children }: { children: ReactNode }) {
  return <div contentEditable={false}>{children}</div>
}

// --- Unbound: search existing boards or create a new one ---
function BoardPicker({
  ctx,
  onBind,
  onRemove,
}: {
  ctx: DocEmbedContextValue
  onBind: (docId: string) => void
  onRemove: () => void
}) {
  const { channelId, hostEditable } = ctx
  const localBoards = useStore((s) => s.docsByChannel[channelId])
  const docsLoaded = useStore((s) => s.docsLoaded)
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const createBoard = useStore((s) => s.createBoard)

  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<BoardRow[]>([])
  const [creating, setCreating] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (channelId && !docsLoaded.has(channelId)) loadChannelDocs(channelId)
  }, [channelId, docsLoaded, loadChannelDocs])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced global board search — merged with the local channel list.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setRemote([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      api
        .docSearch(q, 12)
        .then((res) => {
          if (cancelled) return
          setRemote(
            res.results
              .filter((d) => d.kind === 'board' && !d.deleted_at)
              .map((d) => ({
                id: d.id,
                title: d.title || 'Untitled',
                icon: d.icon || '🗂️',
                channelName: d.channel_name,
              })),
          )
        })
        .catch(() => {
          if (!cancelled) setRemote([])
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: BoardRow[] = []
    for (const d of localBoards ?? []) {
      if (d.kind !== 'board' || d.deleted_at) continue
      if (q && !(d.title || 'Untitled').toLowerCase().includes(q)) continue
      seen.add(d.id)
      out.push({ id: d.id, title: d.title || 'Untitled', icon: d.icon || '🗂️' })
    }
    for (const r of remote) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push(r)
    }
    return out.slice(0, 12)
  }, [localBoards, remote, query])

  // Host is read-only: an embed can't be bound here, so just show a hint.
  if (!hostEditable) {
    return (
      <div className="my-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] px-4 py-3 text-sm text-[var(--color-text-faint)]">
        🗂️ Empty board embed
      </div>
    )
  }

  async function onCreate() {
    if (creating) return
    setCreating(true)
    try {
      const doc = await createBoard(channelId, { title: query.trim() || undefined })
      onBind(doc.id)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      setCreating(false)
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <span className="text-sm">🗂️</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search boards or type a name…"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove board embed"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="max-h-64 overflow-y-auto p-1">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onBind(r.id)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-panel)]"
          >
            <span className="shrink-0">{r.icon}</span>
            <span className="min-w-0 flex-1 truncate">{r.title}</span>
            {r.channelName && (
              <span className="shrink-0 text-xs text-[var(--color-text-faint)]">#{r.channelName}</span>
            )}
          </button>
        ))}
        {rows.length === 0 && (
          <div className="px-2.5 py-2 text-sm text-[var(--color-text-faint)]">No boards found</div>
        )}

        <div className="my-1 border-t border-[var(--color-border)]" />
        <button
          type="button"
          disabled={creating}
          onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--color-accent-hover)] hover:bg-[var(--color-panel)] disabled:opacity-60"
        >
          <span className="shrink-0">＋</span>
          <span className="min-w-0 flex-1 truncate">
            {creating ? 'Creating…' : query.trim() ? `New board “${query.trim()}”` : 'New board'}
          </span>
        </button>
      </div>
    </div>
  )
}

// --- Bound: full interactive board, live view of the same doc ---
function BoundBoard({
  ctx,
  docId,
  onRemove,
}: {
  ctx: DocEmbedContextValue
  docId: string
  onRemove: () => void
}) {
  const { channelId, user, hostEditable } = ctx
  const meta = useStore((s) => s.docMeta[docId])
  const fetchDoc = useStore((s) => s.fetchDoc)

  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const [missing, setMissing] = useState(false)
  const [customizeOpen, setCustomizeOpen] = useState(false)

  // Fetch the board meta for its title + our resolved role, if not cached.
  useEffect(() => {
    if (meta) return
    let cancelled = false
    fetchDoc(docId).catch((e) => {
      if (cancelled) return
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) setMissing(true)
    })
    return () => {
      cancelled = true
    }
  }, [docId, meta, fetchDoc])

  const boardEditable = meta ? (meta.my_role === 'owner' || meta.my_role === 'editor') && !meta.deleted_at : true

  // The sync socket closing (revoked access / deletion) is the same access-lost
  // signal used elsewhere — swap the board for a graceful fallback.
  const lost = missing || status === 'closed'

  const title = meta?.title || 'Untitled'
  const icon = meta?.icon || '🗂️'

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <StatusDot status={status} />
        <span className="shrink-0 text-sm">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
          {title}
        </span>
        {!lost && boardEditable && (
          <ChromeButton onClick={() => setCustomizeOpen(true)}>Customize</ChromeButton>
        )}
        <ChromeButton onClick={() => navigateTo(`/b/${docId}`)}>Open</ChromeButton>
        {hostEditable && (
          <ChromeButton onClick={onRemove} title="Remove embed (keeps the board)">
            Unlink
          </ChromeButton>
        )}
      </div>

      {lost ? (
        <div className="flex h-40 flex-col items-center justify-center gap-1 text-center">
          <div className="text-2xl">🔒</div>
          <p className="text-sm text-[var(--color-text-faint)]">No access or board deleted</p>
        </div>
      ) : (
        <div className="flex h-[460px] flex-col overflow-hidden">
          <BoardEditorInner
            key={docId}
            docId={docId}
            channelId={channelId}
            user={user}
            editable={boardEditable}
            customizeOpen={customizeOpen}
            onCustomizeClose={() => setCustomizeOpen(false)}
            onStatus={setStatus}
            onPeers={noop}
          />
        </div>
      )}
    </div>
  )
}

function ChromeButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
    >
      {children}
    </button>
  )
}

function StatusDot({ status }: { status: DocConnStatus }) {
  const color =
    status === 'connected'
      ? 'var(--color-success-fg)'
      : status === 'connecting'
        ? 'var(--color-warning-fg)'
        : 'var(--color-danger-fg)'
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
}
