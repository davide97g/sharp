import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ApiRequestError, api } from '../lib/api'
import type { GifResult } from '../lib/types'
import { useStore } from '../store'
import { SearchInput, useDismiss } from '../ui'

const PROVIDER_LABELS: Record<string, string> = { giphy: 'GIPHY', tenor: 'Tenor' }

export type GifPickerHandle = {
  move: (dir: 1 | -1) => void
  pickSelected: () => boolean
}

type GifPickerProps = {
  initialQuery?: string
  initialResults?: GifResult[]
  onPick: (g: GifResult) => void
  onClose: () => void
  autoFocus?: boolean
}

export const GifPicker = forwardRef<GifPickerHandle, GifPickerProps>(function GifPicker(
  { initialQuery = '', initialResults, onPick, onClose, autoFocus = true },
  ref,
) {
  const provider = useStore((s) => s.gifConfig?.provider)
  const rootRef = useRef<HTMLDivElement>(null)
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<GifResult[]>(initialResults ?? [])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [typed, setTyped] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notConfigured, setNotConfigured] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useDismiss({ ref: rootRef, onClose })

  useEffect(() => {
    if (initialResults && !typed) return
    const q = query.trim()
    if (!q) {
      setResults([])
      setSelectedIndex(null)
      setLoading(false)
      setNotConfigured(false)
      return
    }

    let cancelled = false
    setSelectedIndex(null)
    setLoading(true)
    setNotConfigured(false)
    const timer = window.setTimeout(() => {
      api
        .searchGifs(q)
        .then(({ results: next }) => {
          if (!cancelled) {
            setResults(next)
            setSelectedIndex(null)
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setResults([])
          setSelectedIndex(null)
          setNotConfigured(error instanceof ApiRequestError && error.status === 503)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [initialResults, query, typed])

  function move(dir: 1 | -1) {
    setSelectedIndex((current) => {
      if (results.length === 0) return null
      if (current === null) return dir === 1 ? 0 : results.length - 1
      return (current + dir + results.length) % results.length
    })
  }

  function pickSelected() {
    if (selectedIndex === null || !results[selectedIndex]) return false
    onPick(results[selectedIndex])
    return true
  }

  useImperativeHandle(ref, () => ({ move, pickSelected }))

  useEffect(() => {
    if (selectedIndex === null) return
    tileRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  async function copyGif(g: GifResult) {
    try {
      await navigator.clipboard.writeText(g.url)
      setCopiedId(g.id)
      window.setTimeout(() => setCopiedId((id) => (id === g.id ? null : id)), 1200)
    } catch {
      // Clipboard may be unavailable outside a secure context.
    }
  }

  const idle =
    !query.trim() && results.length === 0 && (initialResults === undefined || typed)

  return (
    <div
      ref={rootRef}
      className="w-80 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl sm:w-96"
    >
      <div className="border-b border-[var(--color-border)] p-2.5">
        <SearchInput
          variant="boxed"
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => {
            setTyped(true)
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault()
              move(event.shiftKey ? -1 : 1)
            } else if (event.key === 'Enter' && pickSelected()) {
              event.preventDefault()
            }
          }}
          placeholder="Search GIFs…"
        />
      </div>

      <div className="max-h-[360px] min-h-32 overflow-y-auto p-2">
        {loading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Loading GIFs">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="aspect-square animate-pulse rounded-lg bg-[var(--color-panel-2)]"
              />
            ))}
          </div>
        ) : notConfigured ? (
          <div className="flex min-h-28 items-center justify-center px-4 text-center text-sm text-[var(--color-text-dim)]">
            GIF search isn't configured — add a provider key in Settings → Workspace
          </div>
        ) : idle ? (
          <div className="flex min-h-28 items-center justify-center text-sm text-[var(--color-text-faint)]">
            Type to search GIFs
          </div>
        ) : results.length === 0 ? (
          <div className="flex min-h-28 items-center justify-center text-sm text-[var(--color-text-faint)]">
            No GIFs found
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {results.map((g, index) => (
              <div key={g.id} className="group relative overflow-hidden rounded-lg">
                <button
                  ref={(element) => {
                    tileRefs.current[index] = element
                  }}
                  type="button"
                  onClick={() => onPick(g)}
                  className={`block w-full overflow-hidden rounded-lg hover:ring-2 hover:ring-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] ${
                    index === selectedIndex
                      ? 'ring-2 ring-inset ring-[var(--color-accent)]'
                      : ''
                  }`}
                  title={g.title || 'Send GIF'}
                >
                  <img
                    src={g.preview_url}
                    alt={g.title || 'GIF'}
                    loading="lazy"
                    style={{ aspectRatio: `${g.width || 1} / ${g.height || 1}` }}
                    className="block w-full object-cover"
                  />
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    void copyGif(g)
                  }}
                  className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-3xs font-semibold text-white opacity-0 shadow transition hover:bg-black/90 group-hover:opacity-100 focus:opacity-100"
                >
                  {copiedId === g.id ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-right text-3xs text-[var(--color-text-faint)]">
        via {PROVIDER_LABELS[provider ?? ''] ?? 'GIPHY'}
      </div>
    </div>
  )
})
