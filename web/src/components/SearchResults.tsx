import { effectiveNicknames } from '../lib/displayName'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { DocSearchResult, SearchResult } from '../lib/types'
import { Markdown } from './Markdown'
import { Avatar } from './Avatar'
import { fmtTime, fmtDayDivider } from '../lib/util'
import { toastError } from '../lib/toast'
import { channelLabel } from '../lib/util'
import { localSearchResult, searchLocal } from '../lib/e2ee/search'
import { useStore, streamShieldOn } from '../store'

type Tab = 'messages' | 'docs'

export function SearchResults() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const tab: Tab = params.get('tab') === 'docs' ? 'docs' : 'messages'

  const [messages, setMessages] = useState<SearchResult[]>([])
  const [docs, setDocs] = useState<DocSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const channels = useStore((s) => s.channels)
  const nicknames = useStore(effectiveNicknames)
  const setFocus = useStore((s) => s.setFocus)
  const shielded = useStore(streamShieldOn)

  // Hits from private channels/DMs blur while streaming; unknown channels
  // (e.g. local encrypted-DM results) count as private.
  function hitShielded(channelId: string): boolean {
    if (!shielded) return false
    const kind = channels.find((c) => c.id === channelId)?.kind
    return kind !== 'public'
  }

  useEffect(() => {
    if (!q.trim()) {
      setMessages([])
      setDocs([])
      return
    }
    let cancelled = false
    setLoading(true)
    const req = tab === 'docs'
      ? api.docSearch(q, 20)
      : Promise.all([api.search(q, 20), searchLocal(q, 20)]).then(([server, local]) => {
          const seen = new Set(server.results.map((result) => result.id))
          return {
            results: [
              ...server.results,
              ...local
                .filter((row) => !seen.has(row.id))
                .map((row) => {
                  const channel = channels.find((item) => item.id === row.channelId)
                  return localSearchResult(row, channel ? channelLabel(channel, nicknames) : 'Direct message')
                }),
            ],
          }
        })
    req
      .then((res) => {
        if (cancelled) return
        if (tab === 'docs') setDocs((res as { results: DocSearchResult[] }).results)
        else setMessages((res as { results: SearchResult[] }).results)
      })
      .catch((e) => {
        if (!cancelled && e instanceof Error) toastError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [q, tab, channels])

  function setTab(next: Tab) {
    const p = new URLSearchParams(params)
    if (next === 'docs') p.set('tab', 'docs')
    else p.delete('tab')
    setParams(p, { replace: true })
  }

  const results = tab === 'docs' ? docs : messages

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="font-semibold">Search</span>
        <span className="text-sm text-[var(--color-text-dim)]">
          {q ? `Results for "${q}"` : 'Type a query in the sidebar'}
        </span>
      </header>

      <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-4">
        <TabButton active={tab === 'messages'} onClick={() => setTab('messages')}>
          Messages
        </TabButton>
        <TabButton active={tab === 'docs'} onClick={() => setTab('docs')}>
          Docs
        </TabButton>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-lg" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div className="text-3xl">🔍</div>
            <p className="text-sm text-[var(--color-text-dim)]">
              {q
                ? `No ${tab} matched your search.`
                : 'Search across your channels and DMs.'}
            </p>
          </div>
        ) : tab === 'docs' ? (
          <div className="space-y-2">
            <div className="mb-1 text-xs text-[var(--color-text-faint)]">
              {docs.length} {docs.length === 1 ? 'result' : 'results'}
            </div>
            {docs.map((d) => (
              <button
                key={d.id}
                onClick={() => navigate(`${d.kind === 'canvas' ? '/x' : d.kind === 'board' ? '/b' : '/d'}/${d.id}`)}
                className="flex w-full items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-left transition hover:border-[var(--color-accent)]"
              >
                <span className="text-xl">{d.icon || (d.kind === 'canvas' ? '🎨' : d.kind === 'board' ? '🗂️' : '📄')}</span>
                <div className={`min-w-0 flex-1 ${hitShielded(d.channel_id) ? 'stream-blur' : ''}`}>
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="truncate font-semibold">{d.title || 'Untitled'}</span>
                    <span className="shrink-0 text-[11px] text-[var(--color-accent-hover)]">
                      #{d.channel_name}
                    </span>
                  </div>
                  {d.preview && (
                    <p className="line-clamp-2 text-xs text-[var(--color-text-dim)]">
                      {d.preview}
                    </p>
                  )}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="mb-1 text-xs text-[var(--color-text-faint)]">
              {messages.length} {messages.length === 1 ? 'result' : 'results'}
            </div>
            {messages.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setFocus({ channelId: r.channel_id, messageId: r.id, query: q.trim() })
                  navigate(`/c/${r.channel_id}`)
                }}
                className="block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-left transition hover:border-[var(--color-text-faint)]"
              >
                <div className={hitShielded(r.channel_id) ? 'stream-blur' : undefined}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--color-text-faint)]">
                    <span className="font-medium text-[var(--color-accent-hover)]">
                      {r.local ? '🔒 ' : '#'}{r.channel_name}
                    </span>
                    <span>·</span>
                    <span>{fmtDayDivider(r.created_at)}</span>
                    <span>at {fmtTime(r.created_at)}</span>
                  </div>
                  <div className="flex gap-2.5">
                    <Avatar id={r.user.id} name={r.user.display_name} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold">{r.user.display_name}</div>
                      <Markdown content={r.content} />
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-text)]'
          : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]'
      }`}
    >
      {children}
    </button>
  )
}
