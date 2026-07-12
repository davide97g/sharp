import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { SearchResult } from '../lib/types'
import { Markdown } from './Markdown'
import { Avatar } from './Avatar'
import { fmtTime, fmtDayDivider } from '../lib/util'
import { toastError } from '../lib/toast'

export function SearchResults() {
  const [params] = useSearchParams()
  const q = params.get('q') ?? ''
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    if (!q.trim()) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .search(q, 20)
      .then((res) => {
        if (!cancelled) setResults(res.results)
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
  }, [q])

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="font-semibold">Search</span>
        <span className="text-sm text-[var(--color-text-dim)]">
          {q ? `Results for "${q}"` : 'Type a query in the sidebar'}
        </span>
      </header>

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
              {q ? 'No messages matched your search.' : 'Search across your channels and DMs.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="mb-1 text-xs text-[var(--color-text-faint)]">
              {results.length} {results.length === 1 ? 'result' : 'results'}
            </div>
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => navigate(`/c/${r.channel_id}`)}
                className="block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-left transition hover:border-[var(--color-text-faint)]"
              >
                <div className="mb-1.5 flex items-center gap-2 text-xs text-[var(--color-text-faint)]">
                  <span className="font-medium text-[var(--color-accent-hover)]">
                    #{r.channel_name}
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
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
