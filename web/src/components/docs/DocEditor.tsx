// Doc route (`/d/:docId`). The shell — loading, kind guard, title, trash, presence,
// permissions — is DocSurface; this file is the BlockNote body plus backlinks.
//
// Contract: docs/arch/02-docs.md.

import { Suspense, lazy, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import type { Doc } from '../../lib/types'
import { EditorSkeleton } from '../../ui'
import { DocSurface } from './DocSurface'

// BlockNote is the single largest dependency in the app. Loading the editor lazily is what
// keeps it out of the main bundle — DocPeekPanel is mounted on every chat route, so a
// static import here put BlockNote in everyone's cold start whether or not they ever
// opened a doc.
const DocEditorInner = lazy(() =>
  import('./DocEditorInner').then((m) => ({ default: m.DocEditorInner })),
)

export function DocEditor() {
  return (
    <DocSurface kind="doc">
      {({ doc, docId, user, canEdit, onStatus, onPeers, banners, titleRow }) => (
        // Unlike canvas and board, a doc is a scrolling column: the banners, title,
        // editor and backlinks all scroll together.
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8 sm:py-8">
            <div className="mb-4">{banners}</div>
            <div className="mb-4">{titleRow({ size: 'xl' })}</div>

            <Suspense fallback={<EditorSkeleton />}>
              <DocEditorInner
                key={docId}
                docId={docId}
                channelId={doc.channel_id}
                user={user}
                editable={canEdit}
                onStatus={onStatus}
                onPeers={onPeers}
              />
            </Suspense>

            <Backlinks docId={docId} />
          </div>
        </div>
      )}
    </DocSurface>
  )
}

/**
 * Docs that link to this one.
 *
 * Docs only — canvases and boards deliberately write no `doc_links` rows, so this
 * component has no board/canvas counterpart. See docs/LEFTOVERS.md ("intentional
 * non-features").
 */
function Backlinks({ docId }: { docId: string }) {
  const navigate = useNavigate()
  const [backlinks, setBacklinks] = useState<Doc[]>([])

  useEffect(() => {
    let cancelled = false
    setBacklinks([])
    api
      .backlinks(docId)
      .then((res) => {
        if (!cancelled) setBacklinks(res.docs)
      })
      // Backlinks are a nice-to-have; a failure must not break the editor.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [docId])

  if (backlinks.length === 0) return null
  return (
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
  )
}
