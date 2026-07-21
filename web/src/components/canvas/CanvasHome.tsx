import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { channelLabel, fmtDayDivider } from '../../lib/util'
import type { Doc } from '../../lib/types'

export function CanvasHome() {
  const channels = useStore((s) => s.channels)
  const nicknames = useStore((s) => s.nicknames)
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
    for (const c of channels) m[c.id] = channelLabel(c, nicknames)
    return m
  }, [channels, nicknames])

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
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_20rem]">
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
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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

            <MentionsInbox />
          </div>
        </div>
      </div>
    </div>
  )
}

function MentionsInbox() {
  const allMentions = useStore((s) => s.mentions)
  const loadMentions = useStore((s) => s.loadMentions)
  const markMentionsRead = useStore((s) => s.markMentionsRead)
  const navigate = useNavigate()

  useEffect(() => {
    loadMentions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Canvas mode shows canvas mentions only; doc mentions live in Docs mode.
  const mentions = allMentions.filter((m) => m.doc.kind === 'canvas')
  const unreadIds = mentions.filter((m) => !m.read_at).map((m) => m.id)

  function open(docId: string, id: string, unread: boolean) {
    if (unread) markMentionsRead([id])
    navigate(`/x/${docId}`)
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Mentions
        </h2>
        {unreadIds.length > 0 && (
          <button
            onClick={() => markMentionsRead(unreadIds)}
            className="text-[11px] text-[var(--color-accent-hover)] hover:underline"
          >
            Mark all read
          </button>
        )}
      </div>
      {mentions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
          You have no mentions.
        </div>
      ) : (
        <div className="space-y-1.5">
          {mentions.map((m) => {
            const unread = !m.read_at
            return (
              <button
                key={m.id}
                onClick={() => open(m.doc.id, m.id, unread)}
                className={`flex w-full items-start gap-2.5 rounded-lg border p-3 text-left transition ${
                  unread
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-[var(--color-border)] bg-[var(--color-panel)] hover:bg-[var(--color-panel-2)]'
                }`}
              >
                <span className="text-lg">{m.doc.icon || '🎨'}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    <span className="font-semibold">{m.from_user.display_name}</span>
                    <span className="text-[var(--color-text-dim)]"> mentioned you in </span>
                    <span className="font-medium">{m.doc.title || 'Untitled'}</span>
                  </div>
                  <div className="text-[11px] text-[var(--color-text-faint)]">
                    {fmtDayDivider(m.created_at)}
                  </div>
                </div>
                {unread && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
