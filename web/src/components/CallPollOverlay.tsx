import { useEffect, useRef, useState } from 'react'
import { sound } from '../lib/sound'
import { useIsMobile } from '../lib/useMediaQuery'
import { useStore, type VoiceStageMode } from '../store'
import { PollView, callPollToViewModel } from './PollView'

/**
 * Live call poll. Floats over the video stage as a compact card — it never
 * pushes the video grid aside — and collapses to a small badged button.
 * Closed polls disappear entirely; a short sound cue still marks the end.
 */
export function CallPollOverlay({ mode }: { mode: VoiceStageMode }) {
  const poll = useStore((s) => s.callPoll)
  const meId = useStore((s) => s.me?.id ?? null)
  const voteCallPoll = useStore((s) => s.voteCallPoll)
  const closeCallPoll = useStore((s) => s.closeCallPoll)
  const isMobile = useIsMobile()
  const [minimized, setMinimized] = useState(isMobile)
  const previousId = useRef<string | null>(null)
  const sawOpen = useRef(false)

  // New poll: pop the card open on desktop, stay a quiet pill on mobile so it
  // never covers the call on a small screen.
  useEffect(() => {
    if (poll?.id && poll.id !== previousId.current) {
      previousId.current = poll.id
      sawOpen.current = !poll.closed
      setMinimized(isMobile)
    }
  }, [poll?.id, poll?.closed, isMobile])

  useEffect(() => {
    if (!poll) return
    if (!poll.closed) sawOpen.current = true
    else if (sawOpen.current) {
      sawOpen.current = false
      sound.toastSuccess()
    }
  }, [poll])

  if (!poll || poll.closed) return null

  // Placement per stage mode — always floating over the stage, never taking
  // layout space away from the video grid.
  const frame =
    mode === 'mini'
      ? 'fixed bottom-24 right-4 z-[65]'
      : mode === 'full'
        ? 'absolute right-6 top-[calc(4rem_+_var(--safe-top))] z-30'
        : 'absolute right-3 top-14 z-30'

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        aria-label={`Show live poll: ${poll.question}`}
        title={`Live poll: ${poll.question}`}
        className={`${frame} flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-accent-hover)] shadow-2xl outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
      >
        <PollIcon />
        <span
          aria-hidden
          className="call-poll-live-dot absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[var(--color-panel)]"
        />
      </button>
    )
  }

  return (
    <aside
      aria-label="Live poll"
      className={`call-poll-pop flex flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/95 shadow-2xl backdrop-blur-md ${frame} ${
        mode === 'mini'
          ? 'max-h-[min(24rem,55dvh)] w-[min(22rem,calc(100vw-2rem))]'
          : mode === 'full'
            ? 'max-h-[min(30rem,calc(100%-9rem))] w-[min(21rem,calc(100vw-3rem))]'
            : 'max-h-[min(28rem,calc(100%-7.5rem))] w-[min(20rem,calc(100%-1.5rem))]'
      }`}
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] pl-3 pr-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <PollIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--color-text)]">Live poll</span>
        <span aria-hidden className="call-poll-live-dot h-2 w-2 shrink-0 rounded-full" />
        {meId === poll.creator_id ? (
          <button
            type="button"
            onClick={() => closeCallPoll(poll.id)}
            className="min-h-9 shrink-0 rounded-md px-2 text-[11px] font-semibold text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            Close
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setMinimized(true)}
          aria-label="Minimize poll"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          <MinimizeIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <PollView {...callPollToViewModel(poll, meId, (optionIds) => voteCallPoll(poll.id, optionIds), true)} />
      </div>
    </aside>
  )
}

function PollIcon() {
  return (
    <svg className="shrink-0" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  )
}

function MinimizeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 12h12" />
    </svg>
  )
}
