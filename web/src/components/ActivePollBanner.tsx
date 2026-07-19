import { useEffect, useState } from 'react'
import type { Channel, Poll } from '../lib/types'
import { useStore } from '../store'
import { PollView, pollToViewModel } from './PollView'

export function ActivePollBanner({ channel }: { channel: Channel }) {
  const pollsById = useStore((s) => s.pollsById)
  const fetchActivePolls = useStore((s) => s.fetchActivePolls)
  const votePoll = useStore((s) => s.votePoll)
  const [expanded, setExpanded] = useState(false)
  const [expandedPollId, setExpandedPollId] = useState<string | null>(null)

  useEffect(() => {
    if (channel.kind === 'dm') return
    void fetchActivePolls(channel.id).catch(() => {})
  }, [channel.id, channel.kind, fetchActivePolls])

  if (channel.kind === 'dm') return null
  const polls = Object.values(pollsById)
    .filter(
      (poll) =>
        poll.channel_id === channel.id && poll.pinned && !poll.closed_at && !poll.deleted,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  if (polls.length === 0) return null

  if (polls.length > 1 && !expanded) {
    return (
      <div className="border-b border-[var(--color-border)] bg-[var(--color-panel)]/70 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-[var(--color-text)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <PollIcon />
          <span className="flex-1">{polls.length} active polls</span>
          <Chevron expanded={false} />
        </button>
      </div>
    )
  }

  return (
    <section className="max-h-[min(52dvh,28rem)] overflow-y-auto border-b border-[var(--color-border)] bg-[var(--color-panel)]/70 px-3 py-2 sm:px-4" aria-label="Active polls">
      {polls.length > 1 ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-expanded
          className="mb-1 flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-semibold text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
        >
          <PollIcon />
          <span className="flex-1">{polls.length} active polls</span>
          <Chevron expanded />
        </button>
      ) : null}
      <div className="space-y-1.5">
        {polls.map((poll) => {
          const pollExpanded = expandedPollId === poll.id
          return (
            <div key={poll.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
              <button
                type="button"
                onClick={() => setExpandedPollId(pollExpanded ? null : poll.id)}
                aria-expanded={pollExpanded}
                className="flex min-h-10 w-full items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <PollIcon />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--color-text)]">{poll.question}</span>
                  <PollMeta poll={poll} />
                </span>
                <Chevron expanded={pollExpanded} />
              </button>
              {pollExpanded ? (
                <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                  <PollView {...pollToViewModel(poll, (optionIds) => void votePoll(poll.id, optionIds), true)} />
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

function PollMeta({ poll }: { poll: Poll }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!poll.expires_at) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [poll.expires_at])
  const remaining = poll.expires_at
    ? Math.max(0, new Date(poll.expires_at).getTime() - now)
    : null
  const minutes = remaining === null ? null : Math.ceil(remaining / 60_000)
  const countdown =
    minutes === null
      ? null
      : minutes <= 0
        ? 'ending now'
        : minutes >= 60
          ? `ends in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
          : `ends in ${minutes}m`
  return (
    <span className="block text-[11px] text-[var(--color-text-faint)]">
      {poll.total_voters} voted{countdown ? ` · ${countdown}` : ''}
    </span>
  )
}

function PollIcon() {
  return (
    <svg className="shrink-0 text-[var(--color-accent-hover)]" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  )
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`shrink-0 text-[var(--color-text-faint)] transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
