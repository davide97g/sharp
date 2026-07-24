import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { ApiRequestError } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { initials, userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import { Banner, Button, EditorSkeleton, Menu, MenuItem } from '../../ui'
import { BoardEditorInner, type Peer } from './BoardEditorInner'
import { EmojiPicker } from '../docs/EmojiPicker'
import { ShareToChannelModal } from '../docs/ShareToChannelModal'
import { DocRolesModal } from '../docs/DocRolesModal'

export function BoardEditor() {
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
  const [showShare, setShowShare] = useState(false)
  const [showRoles, setShowRoles] = useState(false)
  const [showCustomize, setShowCustomize] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const [title, setTitle] = useState('')
  const titleFocused = useRef(false)
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load meta whenever the board changes.
  useEffect(() => {
    if (!docId) return
    setError(null)
    setStatus('connecting')
    setLost(false)
    everLoaded.current = false
    setPeers([])
    setMenuOpen(false)
    setShowCustomize(false)
    let cancelled = false
    fetchDoc(docId).catch((e) => {
      if (cancelled) return
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        setError("This board doesn't exist or you don't have access to it.")
      } else if (e instanceof Error) {
        setError(e.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [docId, fetchDoc])

  // Kind-guard: a doc/canvas opened at /b/ would bind against the wrong Yjs
  // container. Redirect to the right editor once the meta says what it is.
  useEffect(() => {
    if (doc && doc.kind === 'doc') navigate(`/d/${doc.id}`, { replace: true })
    else if (doc && doc.kind === 'canvas') navigate(`/x/${doc.id}`, { replace: true })
  }, [doc?.kind, doc?.id, navigate])

  useEffect(() => {
    if (doc && !titleFocused.current) setTitle(doc.title)
  }, [doc?.title, docId])

  // Access-lost detection (mirror canvas): once loaded, vanishing from the store
  // means revoked role or deletion; a terminally 'closed' socket is the same.
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
        <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/board')}>
          Back to boards
        </Button>
      </div>
    )
  }

  if (lost) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-[var(--color-ink)] text-center">
        <div className="text-3xl">🔒</div>
        <p className="max-w-sm text-sm text-[var(--color-text-dim)]">
          You no longer have access to this board, or it was deleted.
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={() => navigate('/board')}>
          Back to boards
        </Button>
      </div>
    )
  }

  // While not loaded — or loaded as another kind (the kind-guard effect is
  // redirecting) — show the skeleton and never mount the board.
  if (!doc || doc.kind !== 'board') {
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
      navigate(doc!.channel_id ? `/board/c/${doc!.channel_id}` : '/board')
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
          onClick={() => navigate('/board')}
          aria-label="Back to boards"
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <StatusDot status={status} />
        <div className="min-w-0 flex-1 truncate text-sm"><button onClick={() => navigate('/board')} className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]">‹ Boards</button><span className="mx-1.5 text-[var(--color-text-faint)]">/</span><span className="text-[var(--color-text-dim)]">{doc.title || 'Untitled'}</span></div>
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
              aria-label="Board actions"
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
            <MenuItem
              onClick={() => {
                setMenuOpen(false)
                setShowCustomize(true)
              }}
            >
              Customize properties…
            </MenuItem>
          )}
          {canEdit && (
            <MenuItem danger onClick={onTrash}>
              Move to trash
            </MenuItem>
          )}
        </Menu>
      </header>

      {/* banners + icon/title */}
      <div className="shrink-0 px-4 pt-4 pb-3 sm:px-6">
        {trashed && (
          <Banner
            tone="warning"
            className="mb-3"
            actions={
              canRestore ? (
                <Button size="xs" onClick={onRestore}>
                  Restore
                </Button>
              ) : null
            }
          >
            This board is in the trash.
          </Banner>
        )}
        {!trashed && isViewer && (
          <Banner tone="neutral" className="mb-3">
            You have read-only access to this board.
          </Banner>
        )}

        <div className="flex items-start gap-2">
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
            className="mt-0.5 flex-1 resize-none bg-transparent text-2xl font-bold leading-tight text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
          />
        </div>
      </div>

      {/* board */}
      <BoardEditorInner
        key={docId}
        docId={docId}
        channelId={doc.channel_id}
        user={user}
        editable={canEdit}
        customizeOpen={showCustomize}
        onCustomizeClose={() => setShowCustomize(false)}
        onStatus={setStatus}
        onPeers={setPeers}
      />

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
