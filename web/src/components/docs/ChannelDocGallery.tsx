import { useEffect, useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { fmtDayDivider } from '../../lib/util'
import { toastError } from '../../lib/toast'
import type { Doc, DocKind } from '../../lib/types'
import { ChannelTabs } from '../ChannelTabs'
import { ChannelPaneHeader } from '../ChannelPaneHeader'
import { Button, EmptyState, ListRow } from '../../ui'

type TabKey = 'docs' | 'canvas' | 'board'

const config: Record<
  DocKind,
  { name: string; newLabel: string; tab: TabKey; prefix: string; glyph: string }
> = {
  doc: { name: 'Docs', newLabel: 'New doc', tab: 'docs', prefix: 'd', glyph: '📄' },
  canvas: { name: 'Canvases', newLabel: 'New canvas', tab: 'canvas', prefix: 'x', glyph: '🎨' },
  board: { name: 'Boards', newLabel: 'New board', tab: 'board', prefix: 'b', glyph: '🗂️' },
}

// Shared in-channel gallery for docs / canvases / boards. Lives in chat mode
// (`/c/:id/docs|canvas|board`) so the DocPeekPanel can float alongside it; row
// clicks open that inline peek. When reached from a non-chat route
// (`/docs/c/:id` etc., where AppShell doesn't mount the peek panel) clicks fall
// back to navigating into the full editor — mirrors Markdown.tsx's convention.
export function ChannelDocGallery({ kind }: { kind: DocKind }) {
  const cfg = config[kind]
  const { channelId } = useParams<{ channelId: string }>()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const channels = useStore((s) => s.channels)
  const channel = channels.find((c) => c.id === channelId)
  const docs = useStore((s) => (channelId ? s.docsByChannel[channelId] : undefined))
  const trash = useStore((s) => (channelId ? s.trashByChannel[channelId] : undefined))
  const loaded = useStore((s) => (channelId ? s.docsLoaded.has(channelId) : false))
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const loadChannelTrash = useStore((s) => s.loadChannelTrash)
  const createDoc = useStore((s) => s.createDoc)
  const openDocPeek = useStore((s) => s.openDocPeek)

  const inChat = pathname.startsWith('/c/')

  useEffect(() => {
    if (!channelId) return
    if (!loaded) void loadChannelDocs(channelId)
    void loadChannelTrash(channelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  const items = useMemo(() => (docs ?? []).filter((d) => d.kind === kind), [docs, kind])
  const trashItems = useMemo(() => (trash ?? []).filter((d) => d.kind === kind), [trash, kind])

  // In chat mode open the inline peek; a modified click (or being outside chat)
  // navigates into the full editor instead.
  function open(id: string, forceNav = false) {
    if (inChat && !forceNav) openDocPeek(id)
    else navigate(`/${cfg.prefix}/${id}`)
  }

  async function newItem() {
    if (!channelId) return
    try {
      const doc = await createDoc(channelId, { kind })
      open(doc.id)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    }
  }

  if (!channelId) return null
  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-dim)]">
        Channel not found.
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <ChannelPaneHeader
        channel={channel}
        actions={
          <Button size="sm" onClick={() => void newItem()}>
            + {cfg.newLabel}
          </Button>
        }
      />

      <ChannelTabs channelId={channelId} active={cfg.tab} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-6">
          {loaded && items.length === 0 ? (
            <EmptyState
              variant="dashed"
              icon={<span className="text-xl">{cfg.glyph}</span>}
              title={`No ${cfg.name.toLowerCase()} in this channel yet.`}
              action={
                <Button onClick={() => void newItem()}>Create the first {kind}</Button>
              }
            />
          ) : (
            <div className="space-y-1">
              {items.map((d) => (
                <ListRow
                  key={d.id}
                  size="lg"
                  className="group"
                  leading={<span className="text-lg leading-none">{d.icon || cfg.glyph}</span>}
                  trailing={
                    <span className="text-text-faint opacity-0 transition-opacity group-hover:opacity-100">
                      <ArrowIcon />
                    </span>
                  }
                  onClick={(e: React.MouseEvent) => open(d.id, e.metaKey || e.ctrlKey)}
                >
                  <span className="block truncate font-medium">{d.title || 'Untitled'}</span>
                  <span className="block truncate text-2xs text-text-faint">
                    Updated {fmtDayDivider(d.updated_at)}
                  </span>
                </ListRow>
              ))}
            </div>
          )}

          {trashItems.length > 0 && (
            <section className="mt-8">
              <h2 className="mb-3 text-2xs font-semibold uppercase tracking-wider text-text-faint">
                Trash
              </h2>
              <div className="space-y-1">
                {trashItems.map((d) => (
                  <TrashRow key={d.id} doc={d} glyph={cfg.glyph} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function TrashRow({ doc, glyph }: { doc: Doc; glyph: string }) {
  const restoreDoc = useStore((s) => s.restoreDoc)
  const permanentDeleteDoc = useStore((s) => s.permanentDeleteDoc)

  async function restore() {
    try {
      await restoreDoc(doc.id)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    }
  }

  async function purge() {
    if (!confirm(`Permanently delete "${doc.title || 'Untitled'}"? This cannot be undone.`)) return
    try {
      await permanentDeleteDoc(doc.id)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    }
  }

  const canRestore = doc.my_role === 'owner' || doc.my_role === 'editor'

  return (
    <div className="flex min-h-11 items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
      <span className="text-base opacity-60">{doc.icon || glyph}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-dim)]">
        {doc.title || 'Untitled'}
      </span>
      {canRestore && (
        <Button size="xs" variant="outline" onClick={() => void restore()}>
          Restore
        </Button>
      )}
      {doc.my_role === 'owner' && (
        <Button size="xs" variant="danger" onClick={() => void purge()}>
          Delete forever
        </Button>
      )}
    </div>
  )
}

function ArrowIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  )
}
