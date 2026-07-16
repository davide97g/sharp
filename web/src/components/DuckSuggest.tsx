import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { buildGifToken } from '../lib/gif'
import type { GifResult } from '../lib/types'
import { useStore } from '../store'
import { GifPicker } from './GifPicker'

const lastSuggestAt = new Map<string, number>()

export function DuckSuggest({ channelId }: { channelId: string }) {
  const duck = useStore((state) => state.gifConfig?.duck)
  const activity = useStore((state) => state.duckActivity[channelId])
  const resetDuckActivity = useStore((state) => state.resetDuckActivity)
  const [suggestion, setSuggestion] = useState<{
    query: string
    results: GifResult[]
  } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    setSuggestion(null)
    setPickerOpen(false)
  }, [channelId])

  useEffect(() => {
    if (!duck || (activity?.count ?? 0) < 3) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      const previous = lastSuggestAt.get(channelId) ?? 0
      if (Date.now() - previous <= 120_000) return

      void api
        .gifSuggest(channelId)
        .then(({ query, results }) => {
          if (cancelled) return
          if (query === null) {
            resetDuckActivity(channelId)
            return
          }
          if (results.length === 0) return

          lastSuggestAt.set(channelId, Date.now())
          setSuggestion({ query, results })
          setPickerOpen(false)
          resetDuckActivity(channelId)
        })
        .catch(() => {
          // Suggestions are an optional easter egg; network failures stay silent.
        })
    }, 5_000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activity?.count, activity?.lastAt, channelId, duck, resetDuckActivity])

  if (!duck || !suggestion) return null

  return (
    <div className="duck-suggest-pop pointer-events-auto absolute bottom-2 right-6 z-30">
      {pickerOpen ? (
        <div className="absolute bottom-full right-0 mb-2">
          <GifPicker
            initialQuery={suggestion.query}
            initialResults={suggestion.results}
            onPick={(gif) => {
              void useStore.getState().sendMessage(channelId, buildGifToken(gif))
              setPickerOpen(false)
              setSuggestion(null)
            }}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        aria-label="Open suggested GIF"
        className="duck-suggest-bob relative block h-14 w-[60px] cursor-pointer overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        {!pickerOpen ? <span className="duck-suggest-bubble">gif is ready</span> : null}
        <span className="absolute inset-0 overflow-hidden rounded-xl">
          <img
            src="/duck.png"
            alt=""
            className="absolute -top-5 left-1/2 h-auto w-36 max-w-none -translate-x-1/2 mix-blend-screen"
            draggable={false}
          />
        </span>
      </button>
    </div>
  )
}
