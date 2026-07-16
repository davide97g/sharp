import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { STREAK_QUIET_MS, STREAK_TARGET } from '../lib/duckStreak'
import { buildGifToken } from '../lib/gif'
import type { GifResult } from '../lib/types'
import { useStore } from '../store'

const lastSuggestAt = new Map<string, number>()

export function DuckSuggest({ channelId }: { channelId: string }) {
  const duck = useStore((state) => state.gifConfig?.duck)
  const cooldownMs = (useStore((state) => state.gifConfig?.duck_cooldown_secs) ?? 120) * 1000
  const activity = useStore((state) => state.duckActivity[channelId])
  const resetDuckActivity = useStore((state) => state.resetDuckActivity)
  const [gif, setGif] = useState<GifResult | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    setGif(null)
    setSending(false)
  }, [channelId])

  useEffect(() => {
    // Fast streak: ≥target rapid messages from others, then a short quiet window.
    if (!duck || (activity?.count ?? 0) < STREAK_TARGET) return

    let cancelled = false
    const timer = window.setTimeout(() => {
      const previous = lastSuggestAt.get(channelId) ?? 0
      if (Date.now() - previous <= cooldownMs) return

      void api
        .gifSuggest(channelId)
        .then(({ query, results }) => {
          if (cancelled) return
          if (query === null) {
            resetDuckActivity(channelId)
            return
          }
          const best = results[0]
          if (!best) return

          lastSuggestAt.set(channelId, Date.now())
          setGif(best)
          setSending(false)
          resetDuckActivity(channelId)
        })
        .catch(() => {
          // Suggestions are an optional easter egg; network failures stay silent.
        })
    }, STREAK_QUIET_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activity?.count, activity?.lastAt, channelId, cooldownMs, duck, resetDuckActivity])

  if (!duck || !gif) return null

  async function sendSuggestedGif() {
    if (sending || !gif) return
    setSending(true)
    try {
      await useStore.getState().sendMessage(channelId, buildGifToken(gif))
      setGif(null)
    } catch {
      setSending(false)
    }
  }

  return (
    <div className="duck-suggest-pop pointer-events-auto absolute bottom-2 right-6 z-30">
      <button
        type="button"
        onClick={() => void sendSuggestedGif()}
        disabled={sending}
        aria-label="Send suggested GIF"
        className="duck-suggest-bob relative block h-14 w-[60px] cursor-pointer overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-wait"
      >
        <span className="duck-suggest-bubble">gif is ready</span>
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
