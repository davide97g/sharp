import { useEffect, useState } from 'react'
import { useStore, streamingActive } from '../../store'

/**
 * App-wide Privacy Shield banner, shown whenever streaming mode is active:
 * constant feedback that the screen is being shared plus the shield state —
 * armed, partially paused (some conversations revealed), or fully paused.
 */
export function StreamBanner() {
  const active = useStore(streamingActive)
  const manual = useStore((s) => s.streamManual)
  const revealAllUntil = useStore((s) => s.streamRevealAllUntil)
  const revealChannels = useStore((s) => s.streamRevealChannels)
  const setStreamManual = useStore((s) => s.setStreamManual)
  const clearStreamReveals = useStore((s) => s.clearStreamReveals)
  const expireStreamReveals = useStore((s) => s.expireStreamReveals)

  // 1s tick drives the countdown and prunes lapsed reveal windows in the store,
  // so every shielded surface re-blurs the moment its window expires.
  const [now, setNow] = useState(() => Date.now())
  const hasWindows = revealAllUntil !== null || Object.keys(revealChannels).length > 0
  useEffect(() => {
    if (!hasWindows) return
    setNow(Date.now()) // the clock idles while no window is open — resync first
    const timer = window.setInterval(() => {
      setNow(Date.now())
      expireStreamReveals()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [hasWindows, expireStreamReveals])

  if (!active) return null

  const allRemaining = revealAllUntil ? revealAllUntil - now : 0
  const channelRemaining = Object.values(revealChannels).map((t) => t - now).filter((r) => r > 0)
  const fullyPaused = allRemaining > 0
  const partiallyPaused = !fullyPaused && channelRemaining.length > 0
  const countdown = fullyPaused ? allRemaining : Math.max(0, ...channelRemaining)

  const tone = fullyPaused
    ? 'border-danger/40 bg-gradient-to-r from-danger/25 via-danger/10 to-transparent text-danger-fg'
    : 'border-warning-fg/35 bg-gradient-to-r from-warning/20 via-warning/[0.07] to-transparent text-warning-fg'

  // TODO(ds): kept as a bespoke banner — ui Banner can't express the pulsing
  // live dot + directional gradient + inline countdown/actions. Only the
  // state-driven status colors were mapped to danger/warning tokens.
  return (
    <div
      role="status"
      aria-label={
        fullyPaused
          ? 'Sharing screen, Privacy Shield paused'
          : partiallyPaused
            ? 'Sharing screen, Privacy Shield on with revealed conversations'
            : 'Sharing screen, Privacy Shield on'
      }
      className={`flex min-h-8 shrink-0 items-center gap-2.5 border-b px-3 py-1 text-xs sm:px-4 ${tone}`}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
      </span>
      <span className="text-3xs font-bold uppercase tracking-[0.18em]">Privacy Shield</span>
      <span className="min-w-0 flex-1 truncate font-medium opacity-90">
        {fullyPaused
          ? `paused — everything visible (${formatCountdown(countdown)})`
          : partiallyPaused
            ? `on — ${channelRemaining.length} ${channelRemaining.length === 1 ? 'conversation' : 'conversations'} revealed (${formatCountdown(countdown)})`
            : 'on — private chats, previews & email hidden'}
      </span>
      {(fullyPaused || partiallyPaused) && (
        <button
          type="button"
          onClick={clearStreamReveals}
          className="rounded-full border border-current/40 px-2.5 py-0.5 font-semibold transition hover:bg-danger/10"
        >
          Re-shield now
        </button>
      )}
      {manual && (
        <button
          type="button"
          onClick={() => setStreamManual(false)}
          className="rounded-full border border-current/30 px-2.5 py-0.5 font-semibold opacity-75 transition hover:opacity-100"
        >
          Turn off
        </button>
      )}
    </div>
  )
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
