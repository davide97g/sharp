import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { ApiRequestError, api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { initials, userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import type { Doc } from '../../lib/types'
import { DocEditorInner, type Peer } from './DocEditorInner'
import { EmojiPicker } from './EmojiPicker'
import { ShareToChannelModal } from './ShareToChannelModal'
import { DocRolesModal } from './DocRolesModal'

export function DocEditor() {
  const { docId } = useParams<{ docId: string }>()
  const doc = useStore((s) => (docId ? s.docMeta[docId] : undefined))
  const me = useStore((s) => s.me)
  const fetchDoc = useStore((s) => s.fetchDoc)
  const patchDoc = useStore((s) => s.patchDoc)
  const trashDoc = useStore((s) => s.trashDoc)
  const restoreDoc = useStore((s) => s.restoreDoc)
  const navigate = useNavigate()

  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const [lost, setLost] = useState(false)
  const everLoaded = useRef(false)
  const [peers, setPeers] = useState<Peer[]>([])
  const [backlinks, setBacklinks] = useState<Doc[]>([])
  const [showShare, setShowShare] = useState(false)
  const [showRoles, setShowRoles] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const [title, setTitle] = useState('')
  const titleFocused = useRef(false)
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load meta + backlinks whenever the doc changes.
  useEffect(() => {
    if (!docId) return
    setError(null)
    setStatus('connecting')
    setLost(false)
    everLoaded.current = false
    setPeers([])
    setMenuOpen(false)
    let cancelled = false
    fetchDoc(docId).catch((e) => {
      if (cancelled) return
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        setError("This doc doesn't exist or you don't have access to it.")
      } else if (e instanceof Error) {
        setError(e.message)
      }
    })
    api
      .backlinks(docId)
      .then((res) => {
        if (!cancelled) setBacklinks(res.docs)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [docId, fetchDoc])

  // Sync the title input from meta when not actively editing.
  useEffect(() => {
    if (doc && !titleFocused.current) setTitle(doc.title)
  }, [doc?.title, docId])

  // Access-lost detection. Once the doc has loaded, it vanishing from the store
  // means our role was revoked (my_role -> 'none') or it was permanently
  // deleted (both drop it from the store). A terminally 'closed' sync socket is
  // the same signal from the WS side. Either way, show an access-lost state.
  useEffect(() => {
    if (doc) everLoaded.current = true
    else if (everLoaded.current) setLost(true)
  }, [doc])
  useEffect(() => {
    if (status === 'closed') setLost(true)
  }, [status])

  const user = useMemo(
    () => ({
      name: me?.display_name ?? 'Someone',
      color: userColor(me?.id ?? ''),
    }),
    [me?.display_name, me?.id],
  )

  if (!docId) return null

  if (error) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-[var(--color-ink)] text-center">
        <div className="text-3xl">🚫</div>
        <p className="max-w-sm text-sm text-[var(--color-text-dim)]">{error}</p>
        <button
          onClick={() => navigate('/docs')}
          className="mt-2 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
        >
          Back to docs
        </button>
      </div>
    )
  }

  if (lost) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-[var(--color-ink)] text-center">
        <div className="text-3xl">🔒</div>
        <p className="max-w-sm text-sm text-[var(--color-text-dim)]">
          You no longer have access to this doc, or it was deleted.
        </p>
        <button
          onClick={() => navigate('/docs')}
          className="mt-2 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
        >
          Back to docs
        </button>
      </div>
    )
  }

  if (!doc) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <div className="skeleton mb-4 h-10 w-2/3 rounded-lg" />
          <div className="skeleton mb-2 h-4 rounded" />
          <div className="skeleton mb-2 h-4 w-5/6 rounded" />
          <div className="skeleton h-4 w-4/6 rounded" />
        </div>
      </div>
    )
  }

  const isOwner = doc.my_role === 'owner'
  const trashed = !!doc.deleted_at
  const canEdit = (doc.my_role === 'owner' || doc.my_role === 'editor') && !trashed
  const isViewer = doc.my_role === 'viewer'
  // Restore is editor+ (contract: POST /docs/{id}/restore). This is independent
  // of `canEdit`, which is false on a trashed doc.
  const canRestore = doc.my_role === 'owner' || doc.my_role === 'editor'

  function onTitleChange(v: string) {
    setTitle(v)
    if (patchTimer.current) clearTimeout(patchTimer.current)
    patchTimer.current = setTimeout(() => {
      patchDoc(docId!, { title: v }).catch((e) => {
        if (e instanceof Error) toastError(e.message)
      })
    }, 500)
  }

  function onIconChange(icon: string) {
    patchDoc(docId!, { icon }).catch((e) => {
      if (e instanceof Error) toastError(e.message)
    })
  }

  async function onTrash() {
    setMenuOpen(false)
    try {
      await trashDoc(docId!)
      navigate(`/docs/c/${doc!.channel_id}`)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  }

  async function onRestore() {
    try {
      await restoreDoc(docId!)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      {/* toolbar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5">
        <StatusDot status={status} />
        <div className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-faint)]">
          {doc.icon ? `${doc.icon} ` : ''}
          {doc.title || 'Untitled'}
        </div>
        <Presence peers={peers} />
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            title="Actions"
          >
            •••
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-2xl">
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false)
                    setShowShare(true)
                  }}
                >
                  Share to channel…
                </MenuItem>
                {isOwner && (
                  <MenuItem
                    onClick={() => {
                      setMenuOpen(false)
                      setShowRoles(true)
                    }}
                  >
                    Permissions…
                  </MenuItem>
                )}
                {canEdit && (
                  <MenuItem danger onClick={onTrash}>
                    Move to trash
                  </MenuItem>
                )}
              </div>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-8">
          {/* banners */}
          {trashed && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-[#e0913a]/40 bg-[#e0913a]/10 px-4 py-2.5 text-sm">
              <span className="text-[#e0b06a]">This doc is in the trash.</span>
              {canRestore ? (
                <button
                  onClick={onRestore}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]"
                >
                  Restore
                </button>
              ) : null}
            </div>
          )}
          {!trashed && isViewer && (
            <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5 text-sm text-[var(--color-text-dim)]">
              You have read-only access to this doc.
            </div>
          )}

          {/* icon + title */}
          <div className="mb-4 flex items-start gap-2">
            <EmojiPicker value={doc.icon} disabled={!canEdit} onChange={onIconChange} />
            <textarea
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              onFocus={() => (titleFocused.current = true)}
              onBlur={() => (titleFocused.current = false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault()
              }}
              readOnly={!canEdit}
              rows={1}
              placeholder="Untitled"
              className="mt-0.5 flex-1 resize-none bg-transparent text-3xl font-bold leading-tight text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
            />
          </div>

          {/* editor */}
          <DocEditorInner
            key={docId}
            docId={docId}
            channelId={doc.channel_id}
            user={user}
            editable={canEdit}
            onStatus={setStatus}
            onPeers={setPeers}
          />

          {/* backlinks */}
          {backlinks.length > 0 && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-5">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                Linked from
              </div>
              <div className="flex flex-wrap gap-2">
                {backlinks.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => navigate(`/d/${b.id}`)}
                    className="flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-1.5 text-sm text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
                  >
                    <span>{b.icon || '📄'}</span>
                    <span className="max-w-[16rem] truncate">{b.title || 'Untitled'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showShare && <ShareToChannelModal doc={doc} onClose={() => setShowShare(false)} />}
      {showRoles && <DocRolesModal doc={doc} onClose={() => setShowRoles(false)} />}
    </div>
  )
}

function StatusDot({ status }: { status: DocConnStatus }) {
  const color =
    status === 'connected' ? '#4fbf9f' : status === 'connecting' ? '#e0913a' : '#e05a7d'
  const label =
    status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Offline'
  return (
    <span className="flex items-center gap-1.5" title={label}>
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  )
}

function Presence({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null
  const shown = peers.slice(0, 5)
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((p) => (
        <span
          key={p.clientId}
          title={p.name}
          className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white ring-2 ring-[var(--color-ink)]"
          style={{ backgroundColor: p.color }}
        >
          {initials(p.name)}
        </span>
      ))}
      {peers.length > shown.length && (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-panel-2)] text-[11px] font-semibold text-[var(--color-text-dim)] ring-2 ring-[var(--color-ink)]">
          +{peers.length - shown.length}
        </span>
      )}
    </div>
  )
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--color-panel-2)] ${
        danger ? 'text-[#e05a7d]' : 'text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
