import { useEffect, useRef, useState } from 'react'
import { sound } from '../lib/sound'
import { useStore, type VoiceStageMode } from '../store'
import { PollView, callPollToViewModel } from './PollView'

export function CallPollOverlay({ mode }: { mode: VoiceStageMode }) {
  const poll = useStore((s) => s.callPoll)
  const meId = useStore((s) => s.me?.id ?? null)
  const voteCallPoll = useStore((s) => s.voteCallPoll)
  const closeCallPoll = useStore((s) => s.closeCallPoll)
  const [minimized, setMinimized] = useState(false)
  const previousId = useRef<string | null>(null)
  const sawOpen = useRef(false)

  useEffect(() => {
    if (poll?.id && poll.id !== previousId.current) {
      previousId.current = poll.id
      sawOpen.current = !poll.closed
      setMinimized(false)
    }
  }, [poll?.id, poll?.closed])

  useEffect(() => {
    if (!poll) return
    if (!poll.closed) sawOpen.current = true
    else if (sawOpen.current) {
      sawOpen.current = false
      sound.toastSuccess()
    }
  }, [poll])

  if (!poll) return null
  const full = mode === 'full'
  const expanded = mode === 'expanded'
  const floating = mode === 'compact' || mode === 'mini'

  if (minimized && floating) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        aria-label={`Show poll: ${poll.question}`}
        className="fixed bottom-24 right-4 z-[65] flex h-11 w-11 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-accent-hover)] shadow-2xl outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
      >
        <PollIcon />
      </button>
    )
  }

  const shell = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <PollIcon />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--color-text)]">Live poll</span>
        {meId === poll.creator_id && !poll.closed ? (
          <button type="button" onClick={() => closeCallPoll(poll.id)} className="min-h-9 rounded-md px-2 text-[11px] font-semibold text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]">
            Close
          </button>
        ) : null}
        <button type="button" onClick={() => setMinimized(true)} aria-label="Minimize poll" className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]">
          <MinimizeIcon />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <PollView {...callPollToViewModel(poll, meId, (optionIds) => voteCallPoll(poll.id, optionIds), floating)} />
      </div>
    </div>
  )

  const minimizedButton = (
    <button
      type="button"
      onClick={() => setMinimized(false)}
      aria-label={`Show poll: ${poll.question}`}
      className="mt-5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-accent-hover)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <PollIcon />
    </button>
  )

  if (full) {
    return (
      <aside
        aria-label="Call poll"
        className="flex h-full shrink-0 justify-center overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-ink)] transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: minimized ? 56 : 340 }}
      >
        {minimized ? minimizedButton : <div className="h-full w-[340px]">{shell}</div>}
      </aside>
    )
  }

  if (expanded) {
    return (
      <aside
        aria-label="Call poll"
        className="absolute bottom-[4.2rem] right-0 top-11 z-20 flex justify-center overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-ink)]/95 shadow-2xl backdrop-blur-md transition-[width] duration-200 ease-out motion-reduce:transition-none"
        style={{ width: minimized ? 56 : 'min(340px, 82%)' }}
      >
        {minimized ? minimizedButton : <div className="h-full w-[340px] max-w-full">{shell}</div>}
      </aside>
    )
  }

  return (
    <aside aria-label="Call poll" className={`z-[65] max-h-[min(25rem,65dvh)] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl ${mode === 'mini' ? 'fixed bottom-24 right-4' : 'absolute bottom-[4.5rem] right-3'}`}>
      {shell}
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
