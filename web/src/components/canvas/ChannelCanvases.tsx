import { useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { fmtDayDivider } from '../../lib/util'
import { toastError } from '../../lib/toast'
import type { Doc } from '../../lib/types'
import { ChannelTabs } from '../ChannelTabs'
import { ChannelPaneHeader } from '../ChannelPaneHeader'

export function ChannelCanvases() {
  const { channelId } = useParams<{ channelId: string }>()
  const channels = useStore((s) => s.channels)
  const channel = channels.find((c) => c.id === channelId)
  const docs = useStore((s) => (channelId ? s.docsByChannel[channelId] : undefined))
  const trash = useStore((s) => (channelId ? s.trashByChannel[channelId] : undefined))
  const loaded = useStore((s) => (channelId ? s.docsLoaded.has(channelId) : false))
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const loadChannelTrash = useStore((s) => s.loadChannelTrash)
  const createCanvas = useStore((s) => s.createCanvas)
  const navigate = useNavigate()

  useEffect(() => {
    if (!channelId) return
    if (!loaded) loadChannelDocs(channelId)
    loadChannelTrash(channelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  // Store buckets hold both docs and canvases; keep only canvases here.
  const canvases = useMemo(() => docs?.filter((d) => d.kind === 'canvas'), [docs])
  const trashedCanvases = useMemo(() => trash?.filter((d) => d.kind === 'canvas'), [trash])

  async function newCanvas() {
    if (!channelId) return
    try {
      const doc = await createCanvas(channelId)
      navigate(`/x/${doc.id}`)
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
          <button
            onClick={newCanvas}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)]"
          >
            + New canvas
          </button>
        }
      />

      <ChannelTabs channelId={channelId} active="canvas" />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-6">
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Canvases
            </h2>
            {loaded && (canvases?.length ?? 0) === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
                <div className="mb-2 text-3xl">🎨</div>
                <p className="mb-3 text-sm text-[var(--color-text-dim)]">
                  No canvases in this channel yet.
                </p>
                <button
                  onClick={newCanvas}
                  className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)]"
                >
                  Create the first canvas
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {canvases?.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => navigate(`/x/${d.id}`)}
                    className="flex h-40 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)]"
                  >
                    <span className="text-3xl">{d.icon || '🎨'}</span>
                    <div className="mt-2 line-clamp-2 font-medium">{d.title || 'Untitled'}</div>
                    <span className="mt-auto pt-2 text-[11px] text-[var(--color-text-faint)]">
                      {fmtDayDivider(d.updated_at)}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {(trashedCanvases?.length ?? 0) > 0 && (
            <section className="mt-8">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                Trash
              </h2>
              <div className="space-y-1.5">
                {trashedCanvases?.map((d) => (
                  <TrashRow key={d.id} doc={d} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function TrashRow({ doc }: { doc: Doc }) {
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
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5">
      <span className="text-lg opacity-60">{doc.icon || '🎨'}</span>
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-dim)]">
        {doc.title || 'Untitled'}
      </span>
      {canRestore && (
        <button
          onClick={restore}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          Restore
        </button>
      )}
      {doc.my_role === 'owner' && (
        <button
          onClick={purge}
          className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[#e05a7d] hover:bg-[var(--color-panel-2)]"
        >
          Delete forever
        </button>
      )}
    </div>
  )
}
