import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { ApiRequestError } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { userColor } from '../../lib/util'
import type { DocConnStatus } from '../../lib/docSync'
import type { Doc } from '../../lib/types'
import { Banner, Button, EditorSkeleton, EmptyState } from '../../ui'
// BlockNote is the single largest dependency in the app. Loading the editor
// lazily is what keeps it out of the main bundle — DocPeekPanel is mounted on
// every chat route, so a static import here put BlockNote in everyone's cold
// start whether or not they ever opened a doc.
const DocEditorInner = lazy(() =>
  import('./DocEditorInner').then((m) => ({ default: m.DocEditorInner })),
)
import { BoardEditorInner } from '../board/BoardEditorInner'

// Excalidraw is heavy — lazy-load the inner canvas so its chunk stays out of the
// main bundle (mirrors App.tsx's lazy CanvasEditor).
const CanvasEditorInner = lazy(() =>
  import('../canvas/CanvasEditorInner').then((m) => ({ default: m.CanvasEditorInner })),
)

const noop = () => {}

const KIND_LABEL: Record<Doc['kind'], string> = { doc: 'Doc', canvas: 'Canvas', board: 'Board' }
const KIND_GLYPH: Record<Doc['kind'], string> = { doc: '📄', canvas: '🎨', board: '🗂️' }
const KIND_OPEN: Record<Doc['kind'], { label: string; prefix: string }> = {
  doc: { label: 'Open in Docs', prefix: 'd' },
  canvas: { label: 'Open in Canvas', prefix: 'x' },
  board: { label: 'Open in Board', prefix: 'b' },
}

/**
 * Inline doc/canvas/board peek. Renders over the chat mode's main content
 * column (rail + channel sidebar stay put), so opening a resource from a
 * message chip or the in-channel gallery never leaves the chat app. Two CTAs:
 * Back returns to whatever was underneath, "Open in …" jumps to the full editor.
 */
export function DocPeekPanel() {
  const docPeekId = useStore((s) => s.docPeekId)
  const doc = useStore((s) => (s.docPeekId ? s.docMeta[s.docPeekId] : undefined))
  const me = useStore((s) => s.me)
  const fetchDoc = useStore((s) => s.fetchDoc)
  const closeDocPeek = useStore((s) => s.closeDocPeek)

  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<DocConnStatus>('connecting')

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

  // No Escape-to-close: the embedded editors (Excalidraw menus, BlockNote slash
  // menu) own that key. Back button / navigating away are the exits.

  const user = useMemo(
    () => ({ name: me?.display_name ?? 'Someone', color: userColor(me?.id ?? '') }),
    [me?.display_name, me?.id],
  )

  if (!docPeekId) return null

  const kind = doc?.kind
  const openMeta = kind ? KIND_OPEN[kind] : null

  const header = (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 sm:px-4">
      <Button variant="ghost" size="sm" iconLeft={<BackIcon />} onClick={closeDocPeek}>
        Back
      </Button>
      <span className="hidden h-5 w-px shrink-0 bg-[var(--color-border)] sm:block" />
      <span className="shrink-0 text-base" aria-hidden>
        {doc?.icon || (kind ? KIND_GLYPH[kind] : '📄')}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--color-text)]">
          {doc ? doc.title || 'Untitled' : 'Loading…'}
        </div>
        {kind && <div className="truncate text-2xs text-[var(--color-text-faint)]">{KIND_LABEL[kind]}</div>}
      </div>
      {doc && openMeta && (
        <Button
          variant="outline"
          size="sm"
          iconLeft={<ExpandIcon />}
          onClick={() => {
            closeDocPeek()
            navigateTo(`/${openMeta.prefix}/${doc.id}`)
          }}
        >
          {openMeta.label}
        </Button>
      )}
    </header>
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
            Back
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
            Back
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
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
              <Suspense fallback={<EditorSkeleton />}>
                <DocEditorInner
                  key={doc.id}
                  docId={doc.id}
                  channelId={doc.channel_id}
                  user={user}
                  editable={editable}
                  onStatus={setStatus}
                  onPeers={noop}
                />
              </Suspense>
            </div>
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

  return (
    <section
      className="absolute inset-0 z-20 flex min-w-0 flex-col bg-[var(--color-ink)]"
      aria-label={doc ? doc.title || 'Untitled' : 'Document'}
    >
      {header}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</div>
    </section>
  )
}

function BackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
    </svg>
  )
}
