import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { useIsMobile } from '../../lib/useMediaQuery'
import { ApiRequestError } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import type { Doc } from '../../lib/types'
import { Banner, Button, EditorSkeleton, EmptyState, PanelHeader } from '../../ui'
import { DocEditorInner } from './DocEditorInner'
import { BoardEditorInner } from '../board/BoardEditorInner'

// tldraw is heavy — lazy-load the inner canvas so its chunk stays out of the
// main bundle (mirrors App.tsx's lazy CanvasEditor).
const CanvasEditorInner = lazy(() =>
  import('../canvas/CanvasEditorInner').then((m) => ({ default: m.CanvasEditorInner })),
)

const WIDTH_KEY = 'sharp.docPeekWidth'
const DEFAULT_WIDTH = 480
const MIN_WIDTH = 380
const MAX_WIDTH = 780

function clampWidth(px: number): number {
  const max = Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.6))
  return Math.max(MIN_WIDTH, Math.min(px, Math.max(MIN_WIDTH, max)))
}

const noop = () => {}

const KIND_LABEL: Record<Doc['kind'], string> = { doc: 'Doc', canvas: 'Canvas', board: 'Board' }
const KIND_GLYPH: Record<Doc['kind'], string> = { doc: '📄', canvas: '🎨', board: '🗂️' }
const KIND_OPEN: Record<Doc['kind'], { label: string; prefix: string }> = {
  doc: { label: 'Open in Docs', prefix: 'd' },
  canvas: { label: 'Open in Canvas', prefix: 'x' },
  board: { label: 'Open in Board', prefix: 'b' },
}

export function DocPeekPanel() {
  const docPeekId = useStore((s) => s.docPeekId)
  const doc = useStore((s) => (s.docPeekId ? s.docMeta[s.docPeekId] : undefined))
  const me = useStore((s) => s.me)
  const fetchDoc = useStore((s) => s.fetchDoc)
  const closeDocPeek = useStore((s) => s.closeDocPeek)
  const isMobile = useIsMobile()

  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_KEY))
    return stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH
  })
  const dragging = useRef(false)

  // Load meta whenever the peeked doc changes; surface access/not-found errors.
  useEffect(() => {
    if (!docPeekId) return
    setError(null)
    setStatus('connecting')
    let cancelled = false
    fetchDoc(docPeekId).catch((e) => {
      if (cancelled) return
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 403)) {
        setError("This item doesn't exist or you don't have access to it.")
      } else if (e instanceof Error) {
        setError(e.message)
      }
    })
    return () => {
      cancelled = true
    }
  }, [docPeekId, fetchDoc])

  // Persist the chosen width.
  useEffect(() => {
    window.localStorage.setItem(WIDTH_KEY, String(width))
  }, [width])

  const user = useMemo(
    () => ({ name: me?.display_name ?? 'Someone', color: userColor(me?.id ?? '') }),
    [me?.display_name, me?.id],
  )

  if (!docPeekId) return null

  function onHandleDown(e: React.PointerEvent) {
    e.preventDefault()
    dragging.current = true
    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      // Panel is docked right, so width grows as the pointer moves left.
      setWidth(clampWidth(window.innerWidth - ev.clientX))
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const kind = doc?.kind
  const openMeta = kind ? KIND_OPEN[kind] : null

  const header = (
    <PanelHeader
      title={doc ? doc.title || 'Untitled' : 'Loading…'}
      subtitle={kind ? KIND_LABEL[kind] : undefined}
      icon={
        <span className="text-base" aria-hidden>
          {doc?.icon || (kind ? KIND_GLYPH[kind] : '📄')}
        </span>
      }
      actions={
        doc && openMeta ? (
          <Button
            variant="ghost"
            size="sm"
            iconLeft={<ExpandIcon />}
            onClick={() => {
              closeDocPeek()
              navigateTo(`/${openMeta.prefix}/${doc.id}`)
            }}
          >
            {openMeta.label}
          </Button>
        ) : undefined
      }
      onClose={closeDocPeek}
    />
  )

  let body: React.ReactNode
  if (error) {
    body = (
      <EmptyState
        icon={<span aria-hidden>🚫</span>}
        title="Can't open this"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={closeDocPeek}>
            Close
          </Button>
        }
      />
    )
  } else if (!doc) {
    body = <EditorSkeleton />
  } else if (doc.my_role === 'none') {
    body = (
      <EmptyState
        icon={<span aria-hidden>🔒</span>}
        title="You don't have access"
        description="Ask the owner to share this with you."
        action={
          <Button variant="outline" size="sm" onClick={closeDocPeek}>
            Close
          </Button>
        }
      />
    )
  } else {
    const editable = (doc.my_role === 'owner' || doc.my_role === 'editor') && !doc.deleted_at
    body = (
      <>
        {status === 'offline' && (
          <Banner tone="warning" className="m-2">
            Reconnecting…
          </Banner>
        )}
        {doc.kind === 'doc' ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <DocEditorInner
              key={doc.id}
              docId={doc.id}
              channelId={doc.channel_id}
              user={user}
              editable={editable}
              onStatus={setStatus}
              onPeers={noop}
            />
          </div>
        ) : doc.kind === 'board' ? (
          <BoardEditorInner
            key={doc.id}
            docId={doc.id}
            channelId={doc.channel_id}
            user={user}
            editable={editable}
            customizeOpen={false}
            onCustomizeClose={noop}
            onStatus={setStatus}
            onPeers={noop}
          />
        ) : (
          <Suspense fallback={<EditorSkeleton />}>
            <CanvasEditorInner
              key={doc.id}
              docId={doc.id}
              user={user}
              editable={editable}
              onStatus={setStatus}
              onPeers={noop}
            />
          </Suspense>
        )}
      </>
    )
  }

  if (isMobile) {
    return (
      <aside
        className="mobile-sheet"
        role="dialog"
        aria-modal
        aria-label={doc ? doc.title || 'Untitled' : 'Document'}
      >
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
      </aside>
    )
  }

  return (
    <aside
      className="relative flex shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)]"
      style={{ width }}
      aria-label={doc ? doc.title || 'Untitled' : 'Document'}
    >
      {/* Drag handle to resize the panel from its left edge. */}
      <div
        onPointerDown={onHandleDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
      />
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </aside>
  )
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
    </svg>
  )
}
