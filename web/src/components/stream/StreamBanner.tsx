import { useEffect, useState } from 'react'
import { useStore, streamingActive } from '../../store'

/**
 * App-wide top banner shown whenever streaming mode is active: constant
 * feedback that the screen is being shared, plus the shield/paused state.
 */
export function StreamBanner() {
  const active = useStore(streamingActive)
  const manual = useStore((s) => s.streamManual)
  const pauseUntil = useStore((s) => s.streamPauseUntil)
  const setStreamManual = useStore((s) => s.setStreamManual)
  const clearStreamReveal = useStore((s) => s.clearStreamReveal)

  // 1s tick drives the countdown and flips paused → shielded when the window
  // lapses (the shield itself is a lazy timestamp comparison in the store).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!pauseUntil) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pauseUntil])

  if (!active) return null

  const remaining = pauseUntil ? pauseUntil - now : 0
  const paused = remaining > 0

  return (
    <div
      role="status"
      aria-label={paused ? 'Streaming, protection paused' : 'Streaming, private content hidden'}
      className={`flex min-h-8 shrink-0 items-center gap-2 border-b px-3 py-1 text-xs font-semibold sm:px-4 ${
        paused
          ? 'border-red-500/40 bg-red-500/15 text-red-500'
          : 'border-amber-500/40 bg-amber-500/15 text-amber-500'
      }`}
    >
      <BroadcastIcon />
      <span className="min-w-0 flex-1 truncate">
        {paused
          ? `Streaming — protection paused (${formatCountdown(remaining)})`
          : 'Streaming — private content hidden'}
      </span>
      {paused ? (
        <button
          type="button"
          onClick={clearStreamReveal}
          className="rounded-md border border-red-500/40 px-2 py-0.5 font-semibold hover:bg-red-500/10"
        >
          Re-enable now
        </button>
      ) : null}
      {manual ? (
        <button
          type="button"
          onClick={() => setStreamManual(false)}
          className="rounded-md border border-current/30 px-2 py-0.5 font-semibold opacity-80 hover:opacity-100"
        >
          Turn off
        </button>
      ) : null}
    </div>
  )
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function BroadcastIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="shrink-0 animate-pulse"
      aria-hidden
    >
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
    </svg>
  )
}
