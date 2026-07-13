import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { channelLabel, fmtDayDivider } from '../../lib/util'
import type { Doc } from '../../lib/types'

export function CanvasHome() {
  const channels = useStore((s) => s.channels)
  const docsByChannel = useStore((s) => s.docsByChannel)
  const docsLoaded = useStore((s) => s.docsLoaded)
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const navigate = useNavigate()

  const myChannels = useMemo(
    () => channels.filter((c) => c.kind !== 'dm' && c.is_member),
    [channels],
  )

  // Load docs for every member channel so "Recent" spans everything.
  // (loadChannelDocs fetches both docs and canvases in one request.)
  useEffect(() => {
    for (const c of myChannels) {
      if (!docsLoaded.has(c.id)) loadChannelDocs(c.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myChannels])

  const channelName = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of channels) m[c.id] = channelLabel(c)
    return m
  }, [channels])

  const recent = useMemo(() => {
    const all: Doc[] = []
    for (const list of Object.values(docsByChannel)) all.push(...list)
    return all
      .filter((d) => d.kind === 'canvas' && !d.deleted_at)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .slice(0, 24)
  }, [docsByChannel])

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-5">
        <span className="font-semibold">Canvas</span>
        <span className="text-sm text-[var(--color-text-dim)]">Your whiteboards</span>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              Recent
            </h2>
            {recent.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
                <div className="mb-2 text-3xl">🎨</div>
                <p className="text-sm text-[var(--color-text-dim)]">
                  No canvases yet. Pick a channel in the sidebar and create one.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {recent.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => navigate(`/x/${d.id}`)}
                    className="group flex flex-col gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{d.icon || '🎨'}</span>
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {d.title || 'Untitled'}
                      </span>
                    </div>
                    <div className="mt-auto flex items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
                      <span className="text-[var(--color-accent-hover)]">
                        #{channelName[d.channel_id] ?? '…'}
                      </span>
                      <span>·</span>
                      <span>{fmtDayDivider(d.updated_at)}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
