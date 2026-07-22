import { useEffect, useRef } from 'react'

export function HubPage({
  title,
  count,
  primaryLabel,
  onPrimary,
  query,
  onQueryChange,
  filters,
  sort,
  onSortChange,
  children,
}: {
  title: string
  count?: number
  primaryLabel?: string
  onPrimary?: () => void
  query: string
  onQueryChange: (value: string) => void
  filters?: React.ReactNode
  sort?: string
  onSortChange?: (value: string) => void
  children: React.ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)

  // `/` focuses the hub search unless typing in an editable target.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === '/' &&
        !(
          event.target instanceof HTMLElement &&
          (event.target.isContentEditable ||
            event.target.closest('input, textarea, select, [contenteditable=true]'))
        )
      ) {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
          <header className="mb-7">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-3xl font-semibold tracking-[-0.04em] text-[var(--color-text)] sm:text-4xl">
                  {title}
                </h1>
                {count !== undefined && (
                  <p className="mt-1 text-sm text-[var(--color-text-faint)]">
                    {count} {count === 1 ? 'item' : 'items'}
                  </p>
                )}
              </div>
              {primaryLabel && (
                <button
                  onClick={onPrimary}
                  className="min-h-11 rounded-lg bg-[var(--color-accent)] px-4 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-ink)]"
                >
                  {primaryLabel}
                </button>
              )}
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              <label className="relative min-w-[min(100%,22rem)] flex-1">
                <span className="sr-only">Search {title}</span>
                <svg
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]"
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden
                >
                  <circle cx="11" cy="11" r="7" />
                  <path d="m20 20-3.5-3.5" />
                </svg>
                <input
                  ref={input}
                  autoFocus
                  value={query}
                  onChange={(event) => onQueryChange(event.target.value)}
                  placeholder={`Search ${title.toLowerCase()}…`}
                  className="min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] py-2 pl-10 pr-4 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                />
              </label>
              {sort && onSortChange && (
                <select
                  aria-label="Sort"
                  value={sort}
                  onChange={(event) => onSortChange(event.target.value)}
                  className="min-h-11 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 text-sm text-[var(--color-text-dim)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <option value="updated">Recently updated</option>
                  <option value="title">Title A–Z</option>
                  <option value="newest">Newest</option>
                </select>
              )}
            </div>
            {filters && <div className="mt-3">{filters}</div>}
          </header>
          {children}
        </div>
      </div>
    </main>
  )
}
