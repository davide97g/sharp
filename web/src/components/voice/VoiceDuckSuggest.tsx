import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { buildGifToken } from '../../lib/gif'
import { useStore } from '../../store'

const lastSuggestAt = new Map<string, number>()

export function VoiceDuckSuggest() {
  const channelId = useStore((state) => state.voice.channelId)
  const roastArmed = useStore((state) => state.voice.roastArmed)
  const isGuest = useStore((state) => state.isGuest)
  const cooldownMs = (useStore((state) => state.gifConfig?.duck_cooldown_secs) ?? 120) * 1000
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setBusy(false)
  }, [channelId])

  if (!channelId || !roastArmed || isGuest) return null
  const activeChannelId = channelId

  function disarm() {
    useStore.setState((state) =>
      state.voice.channelId === activeChannelId
        ? { voice: { ...state.voice, roastArmed: false } }
        : {},
    )
  }

  async function triggerSuggestion() {
    if (busy) return
    const previous = lastSuggestAt.get(activeChannelId) ?? 0
    if (Date.now() - previous <= cooldownMs) return

    setBusy(true)
    try {
      const { query, results } = await api.gifSuggestVoice(activeChannelId)
      if (useStore.getState().voice.channelId !== activeChannelId) return
      if (results.length === 0) {
        disarm()
        return
      }
      lastSuggestAt.set(activeChannelId, Date.now())
      await useStore
        .getState()
        .sendMessage(
          activeChannelId,
          buildGifToken(results[0], { duck: true, query: query ?? undefined }),
        )
      disarm()
    } catch {
      // Optional easter egg — keep the CTA so they can retry.
    } finally {
      setBusy(false)
    }
  }

  const onCooldown =
    Date.now() - (lastSuggestAt.get(activeChannelId) ?? 0) <= cooldownMs && !busy

  return (
    <div className="duck-suggest-pop pointer-events-auto absolute bottom-2 right-6 z-30">
      <button
        type="button"
        onClick={() => void triggerSuggestion()}
        disabled={busy || onCooldown}
        aria-label="Trigger voice GIF suggestion"
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
