import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { duckStreakArmed, STREAK_GAP_MS } from '../lib/duckStreak'
import { buildGifToken } from '../lib/gif'
import type { GifResult } from '../lib/types'
import { useStore } from '../store'

const lastSuggestAt = new Map<string, number>()

export function DuckSuggest({ channelId }: { channelId: string }) {
  const duck = useStore((state) => state.gifConfig?.duck)
  const cooldownMs = (useStore((state) => state.gifConfig?.duck_cooldown_secs) ?? 120) * 1000
  const activity = useStore((state) => state.duckActivity[channelId])
  const resetDuckActivity = useStore((state) => state.resetDuckActivity)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    setBusy(false)
  }, [channelId])

  // Re-evaluate arming as the shared streak decays over time.
  useEffect(() => {
    if (!duck) {
      setArmed(false)
      return
    }
    const id = window.setInterval(() => setTick((n) => n + 1), 250)
    return () => window.clearInterval(id)
  }, [duck])

  useEffect(() => {
    if (!duck) {
      setArmed(false)
      return
    }
    const count = activity?.count ?? 0
    const lastAt = activity?.lastAt ?? 0
    if (count > 0 && lastAt > 0 && Date.now() - lastAt >= STREAK_GAP_MS) {
      resetDuckActivity(channelId)
      setArmed(false)
      return
    }
    setArmed(duckStreakArmed(count, lastAt))
  }, [activity?.count, activity?.lastAt, channelId, duck, resetDuckActivity, tick])

  if (!duck || !armed) return null

  async function triggerSuggestion() {
    if (busy) return
    const previous = lastSuggestAt.get(channelId) ?? 0
    if (Date.now() - previous <= cooldownMs) return

    setBusy(true)
    try {
      const { query, results } = await api.gifSuggest(channelId)
      if (query === null || results.length === 0) {
        resetDuckActivity(channelId)
        setArmed(false)
        return
      }
      const best: GifResult = results[0]
      lastSuggestAt.set(channelId, Date.now())
      await useStore.getState().sendMessage(
        channelId,
        buildGifToken(best, { duck: true, query }),
      )
      setArmed(false)
    } catch {
      // Optional easter egg — keep the CTA so they can retry.
    } finally {
      setBusy(false)
    }
  }

  const onCooldown =
    Date.now() - (lastSuggestAt.get(channelId) ?? 0) <= cooldownMs && !busy

  return (
    <div className="duck-suggest-pop pointer-events-auto absolute bottom-2 right-6 z-30">
      <button
        type="button"
        onClick={() => void triggerSuggestion()}
        disabled={busy || onCooldown}
        aria-label="Trigger GIF suggestion"
        className="duck-suggest-bob relative block h-14 w-[60px] cursor-pointer overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-wait"
      >
        <span className="duck-suggest-bubble">
          {busy ? 'cooking…' : onCooldown ? 'cooling off' : 'drop a roast'}
        </span>
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
