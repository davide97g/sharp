// The shell every collaborative surface shares: doc, canvas and board.
//
// Contract: docs/arch/02-docs.md (roles, sync socket) and 03-canvas-board.md.
//
// All three are the same `docs` row with a different `kind`, so all three need the same
// shell — load meta, guard the kind, edit the title, trash/restore, presence, connection
// status, share and permissions. That shell lived in triplicate in DocEditor,
// CanvasEditor and BoardEditor, which is how their access-lost handling and their
// role gates drifted a little apart.
//
// The *body* is intentionally not shared: a doc scrolls inside a centered column, while a
// canvas and a board fill the remaining space and must not scroll. Each kind renders its
// own body via the `children` render prop, placing the `banners` and `titleRow` the shell
// hands it wherever its own layout needs them.
//
// Two rules encoded here that are easy to get wrong:
//
//   1. **Never mount an editor for the wrong kind.** Binding BlockNote against a
//      canvas's Yjs container (or tldraw against a doc's) corrupts the document. The
//      kind-guard effect redirects, and until it has, this renders a skeleton rather
//      than the body.
//   2. **Access loss is silent.** A revoked role and a permanent delete both just drop
//      the doc from the store, and the sync socket goes terminally 'closed'. Both are
//      treated as access-lost; without that the user stares at a stale editor that
//      cannot save.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { ApiRequestError } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { initials, userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import type { Doc, DocKind, DocPeer } from '../../lib/types'
import { Banner, Button, EditorSkeleton, Menu, MenuItem } from '../../ui'
import { EmojiPicker } from './EmojiPicker'
import { ShareToChannelModal } from './ShareToChannelModal'
import { DocRolesModal } from './DocRolesModal'

/** Re-exported so a body can type its own peer handling without a second import. */
export type SurfacePeer = DocPeer

/** Per-kind wording and routing. One entry per `DocKind`. */
type KindConfig = {
  /** Rail route for this kind, e.g. `/docs`. */
  home: string
  /** Per-channel list route builder, used after trashing. */
  channelHome: (channelId: string | null) => string
  /** Route for a doc of this kind, used by the kind-guard redirect. */
  route: (id: string) => string
  /** Breadcrumb label, e.g. "Docs". */
  crumb: string
  /** Lower-case singular used in prose: "This doc is in the trash." */
  noun: string
  /** Plural used on the back buttons: "Back to docs". */
  plural: string
  /** `aria-label` of the actions menu trigger. */
  menuLabel: string
}

const KINDS: Record<DocKind, KindConfig> = {
  doc: {
    home: '/docs',
    channelHome: (channelId) => (channelId ? `/docs/c/${channelId}` : '/docs'),
    route: (id) => `/d/${id}`,
    crumb: 'Docs',
    noun: 'doc',
    plural: 'docs',
    menuLabel: 'Document actions',
  },
  canvas: {
    home: '/canvas',
    channelHome: (channelId) => (channelId ? `/canvas/c/${channelId}` : '/canvas'),
    route: (id) => `/x/${id}`,
    crumb: 'Canvas',
    noun: 'canvas',
    plural: 'canvases',
    menuLabel: 'Canvas actions',
  },
  board: {
    home: '/board',
    channelHome: (channelId) => (channelId ? `/board/c/${channelId}` : '/board'),
    route: (id) => `/b/${id}`,
    crumb: 'Boards',
    noun: 'board',
    plural: 'boards',
    menuLabel: 'Board actions',
  },
}

/**
 * Route to a doc of any kind — the one place that knows `/d/`, `/x/` and `/b/`.
 * Anything linking to a doc it did not open (board card references, search hits)
 * should build its href from here rather than re-deriving the prefix.
 */
export function docRoute(kind: DocKind, id: string): string {
  return KINDS[kind].route(id)
}

/** What the shell hands the body. */
export type DocSurfaceContext = {
  doc: Doc
  docId: string
  /** Identity for the collaborative cursor. */
  user: { name: string; color: string }
  /** Owner or editor, and not trashed. Gate every write on this. */
  canEdit: boolean
  /** Feed the sync socket's status back so the shell can show it and detect access loss. */
  onStatus: (status: DocConnStatus) => void
  onPeers: (peers: SurfacePeer[]) => void
  /** Trash/read-only notices. Render inside your own layout. */
  banners: ReactNode
  /** Emoji picker + title textarea. Render inside your own layout. */
  titleRow: (opts?: { size?: 'lg' | 'xl' }) => ReactNode
}

type Props = {
  kind: DocKind
  /** Extra items for the actions menu, above "Move to trash". */
  menuExtras?: (ctx: { canEdit: boolean; close: () => void }) => ReactNode
  children: (ctx: DocSurfaceContext) => ReactNode
}

export function DocSurface({ kind, menuExtras, children }: Props) {
  const cfg = KINDS[kind]
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
  const [peers, setPeers] = useState<SurfacePeer[]>([])
  const [showShare, setShowShare] = useState(false)
  const [showRoles, setShowRoles] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const [title, setTitle] = useState('')
  const titleFocused = useRef(false)
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load meta whenever the id changes, resetting everything derived from the old one.
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
        setError(`This ${cfg.noun} doesn't exist or you don't have access to it.`)
      } else if (e instanceof Error) {
        setError(e.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [docId, fetchDoc, cfg.noun])

  // Kind-guard: see rule 1 in the header comment.
  useEffect(() => {
    if (doc && doc.kind !== kind) navigate(KINDS[doc.kind].route(doc.id), { replace: true })
  }, [doc?.kind, doc?.id, kind, navigate])

  // Sync the title input from meta when not actively editing, so a remote rename lands
  // without stealing the caret mid-word.
  useEffect(() => {
    if (doc && !titleFocused.current) setTitle(doc.title)
  }, [doc?.title, docId])

  // Access-lost detection: see rule 2 in the header comment.
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
    return <DeadEnd icon="🚫" message={error} onBack={() => navigate(cfg.home)} cfg={cfg} />
  }

  if (lost) {
    return (
      <DeadEnd
        icon="🔒"
        message={`You no longer have access to this ${cfg.noun}, or it was deleted.`}
        onBack={() => navigate(cfg.home)}
        cfg={cfg}
      />
    )
  }

  // Not loaded, or loaded as another kind while the kind-guard redirects.
  if (!doc || doc.kind !== kind) {
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
  // Restore is editor+ (contract: POST /docs/{id}/restore) and is independent of
  // `canEdit`, which is false precisely because the doc is trashed.
  const canRestore = doc.my_role === 'owner' || doc.my_role === 'editor'

  function onTitleChange(v: string) {
    setTitle(v)
    // Debounced: the title input fires per keystroke and each PATCH broadcasts
    // doc.updated to every member.
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
      navigate(cfg.channelHome(doc!.channel_id))
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

  const banners = (
    <>
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
          This {cfg.noun} is in the trash.
        </Banner>
      )}
      {!trashed && isViewer && (
        <Banner tone="neutral" className="mb-3">
          You have read-only access to this {cfg.noun}.
        </Banner>
      )}
    </>
  )

  const titleRow = ({ size = 'lg' }: { size?: 'lg' | 'xl' } = {}) => (
    <div className="flex items-start gap-2">
      <EmojiPicker value={doc.icon} disabled={!canEdit} onChange={onIconChange} />
      <textarea
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        onFocus={() => (titleFocused.current = true)}
        onBlur={() => (titleFocused.current = false)}
        onKeyDown={(e) => {
          // Enter would insert a newline into a single-line title.
          if (e.key === 'Enter') e.preventDefault()
        }}
        readOnly={!canEdit}
        rows={1}
        placeholder="Untitled"
        className={`mt-0.5 flex-1 resize-none bg-transparent font-bold leading-tight text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none ${
          size === 'xl' ? 'text-3xl' : 'text-2xl'
        }`}
      />
    </div>
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 sm:gap-3 sm:px-5">
        <button
          type="button"
          onClick={() => navigate(cfg.home)}
          aria-label={`Back to ${cfg.plural}`}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] md:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <StatusDot status={status} />
        <div className="min-w-0 flex-1 truncate text-sm">
          <button
            onClick={() => navigate(cfg.home)}
            className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          >
            ‹ {cfg.crumb}
          </button>
          <span className="mx-1.5 text-[var(--color-text-faint)]">/</span>
          <span className="text-[var(--color-text-dim)]">{doc.title || 'Untitled'}</span>
        </div>
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
              aria-label={cfg.menuLabel}
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
          {menuExtras?.({ canEdit, close: () => setMenuOpen(false) })}
          {canEdit && (
            <MenuItem danger onClick={onTrash}>
              Move to trash
            </MenuItem>
          )}
        </Menu>
      </header>

      {children({
        doc,
        docId,
        user,
        canEdit,
        onStatus: setStatus,
        onPeers: setPeers,
        banners,
        titleRow,
      })}

      {showShare && <ShareToChannelModal doc={doc} onClose={() => setShowShare(false)} />}
      {showRoles && <DocRolesModal doc={doc} onClose={() => setShowRoles(false)} />}
    </div>
  )
}

function DeadEnd({
  icon,
  message,
  onBack,
  cfg,
}: {
  icon: string
  message: string
  onBack: () => void
  cfg: KindConfig
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 bg-[var(--color-ink)] text-center">
      <div className="text-3xl">{icon}</div>
      <p className="max-w-sm text-sm text-[var(--color-text-dim)]">{message}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onBack}>
        Back to {cfg.plural}
      </Button>
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
function Presence({ peers }: { peers: SurfacePeer[] }) {
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
