import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { ApiRequestError, api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { initials, userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import type { Doc } from '../../lib/types'
import { Banner, Button, EditorSkeleton, Menu, MenuItem } from '../../ui'
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

  // Kind-guard: a canvas opened at /d/ would bind BlockNote against the wrong
  // Yjs container. Redirect to the canvas editor once the meta says it's a canvas.
  useEffect(() => {
    if (doc && doc.kind === 'canvas') navigate(`/x/${doc.id}`, { replace: true })
  }, [doc?.kind, doc?.id, navigate])

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
        <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/docs')}>
          Back to docs
        </Button>
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
        <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/docs')}>
          Back to docs
        </Button>
      </div>
    )
  }

  // While not loaded — or loaded as a canvas (the kind-guard effect is
  // redirecting) — show the skeleton and never mount the BlockNote editor.
  if (!doc || doc.kind === 'canvas') {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
        <EditorSkeleton />
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 sm:gap-3 sm:px-5">
        <button
          type="button"
          onClick={() => navigate('/docs')}
          aria-label="Back to docs"
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <StatusDot status={status} />
        <div className="min-w-0 flex-1 truncate text-sm"><button onClick={() => navigate('/docs')} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">‹ Docs</button><span className="mx-1.5 text-[var(--color-text-faint)]">/</span><span className="text-[var(--color-text-dim)]">{doc.title || 'Untitled'}</span></div>
        <Presence peers={peers} />
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          align="end"
          width="w-52"
          trigger={
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="flex h-11 w-11 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] sm:h-9 sm:w-9"
              title="Actions"
              aria-label="Document actions"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
          }
        >
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
        </Menu>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
          {/* banners */}
          {trashed && (
            <Banner
              tone="warning"
              className="mb-4"
              actions={
                canRestore ? (
                  <Button size="xs" onClick={onRestore}>
                    Restore
                  </Button>
                ) : null
              }
            >
              This doc is in the trash.
            </Banner>
          )}
          {!trashed && isViewer && (
            <Banner tone="neutral" className="mb-4">
              You have read-only access to this doc.
            </Banner>
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
    status === 'connected'
      ? 'var(--color-success-fg)'
      : status === 'connecting'
        ? 'var(--color-warning-fg)'
        : 'var(--color-danger-fg)'
  const label =
    status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Offline'
  return (
    <span className="flex items-center gap-1.5" title={label}>
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    </span>
  )
}

// TODO(ds): AvatarStack — collab-presence ring uses live p.color, kept custom.
function Presence({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null
  const shown = peers.slice(0, 5)
  return (
    <div className="flex items-center -space-x-1.5">
      {shown.map((p) => (
        <span
          key={p.clientId}
          title={p.name}
          className="flex h-7 w-7 items-center justify-center rounded-full text-2xs font-semibold text-white ring-2 ring-[var(--color-ink)]"
          style={{ backgroundColor: p.color }}
        >
          {initials(p.name)}
        </span>
      ))}
      {peers.length > shown.length && (
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-panel-2)] text-2xs font-semibold text-[var(--color-text-dim)] ring-2 ring-[var(--color-ink)]">
          +{peers.length - shown.length}
        </span>
      )}
    </div>
  )
}
