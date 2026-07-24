import { useEffect, useState } from 'react'
import type { CallPoll, Poll, PollVoter } from '../lib/types'
import { Avatar } from './Avatar'

export type PollViewModel = {
  question: string
  multi: boolean
  options: {
    id: string
    text: string
    count: number
    voters: PollVoter[]
    mine: boolean
  }[]
  totalVoters: number
  expiresAt: string | null
  closed: boolean
  closedReason: 'manual' | 'expired' | null
  canVote: boolean
  onVote: (optionIds: string[]) => void
  compact?: boolean
}

export function pollToViewModel(
  poll: Poll,
  onVote: (optionIds: string[]) => void,
  compact = false,
): PollViewModel {
  const mine = new Set(poll.my_votes)
  return {
    question: poll.question,
    multi: poll.multi,
    options: poll.options.map((option) => ({
      id: option.id,
      text: option.text,
      count: option.count,
      voters: option.voters,
      mine: mine.has(option.id),
    })),
    totalVoters: poll.total_voters,
    expiresAt: poll.expires_at,
    closed: poll.closed_at !== null,
    closedReason: poll.closed_reason,
    canVote: poll.closed_at === null && !poll.deleted,
    onVote,
    compact,
  }
}

export function callPollToViewModel(
  poll: CallPoll,
  ownUserId: string | null,
  onVote: (optionIds: string[]) => void,
  compact = false,
): PollViewModel {
  const voterIds = new Set<string>()
  return {
    question: poll.question,
    multi: poll.multi,
    options: poll.options.map((option) => {
      for (const voter of option.voters) voterIds.add(voter.id)
      return {
        id: option.id,
        text: option.text,
        count: option.count,
        voters: option.voters,
        mine: ownUserId !== null && option.voters.some((voter) => voter.id === ownUserId),
      }
    }),
    totalVoters: voterIds.size,
    expiresAt: poll.expires_at,
    closed: poll.closed,
    closedReason: poll.closed ? 'manual' : null,
    canVote: !poll.closed,
    onVote,
    compact,
  }
}

export function PollView({
  question,
  multi,
  options,
  totalVoters,
  expiresAt,
  closed,
  closedReason,
  canVote,
  onVote,
  compact = false,
}: PollViewModel) {
  const countdown = useCountdown(expiresAt, closed)
  const maxVotes = options.reduce((max, option) => Math.max(max, option.count), 0)
  const winnerId = closed && maxVotes > 0
    ? options.find((option) => option.count === maxVotes)?.id
    : undefined
  const selectedIds = options.filter((option) => option.mine).map((option) => option.id)

  function choose(optionId: string) {
    if (!canVote || closed) return
    const selected = selectedIds.includes(optionId)
    if (multi) {
      onVote(selected ? selectedIds.filter((id) => id !== optionId) : [...selectedIds, optionId])
    } else {
      onVote(selected ? [] : [optionId])
    }
  }

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className="flex items-start gap-2">
        <PollIcon />
        <div className="min-w-0 flex-1">
          <h3 className={`${compact ? 'text-sm' : 'text-[15px]'} break-words font-semibold leading-snug text-[var(--color-text)]`}>
            {question}
          </h3>
          <p className="mt-0.5 text-2xs text-[var(--color-text-faint)]">
            {closed
              ? closedReason === 'expired'
                ? 'Poll ended'
                : 'Poll closed'
              : multi
                ? 'Choose one or more'
                : 'Choose one'}
            {countdown ? ` · ${countdown}` : ''}
          </p>
        </div>
      </div>

      <div className="space-y-1.5" aria-live="polite">
        {options.map((option) => {
          const percentage = totalVoters > 0 ? Math.round((option.count / totalVoters) * 100) : 0
          const winner = option.id === winnerId
          const voterNames = option.voters.map((voter) => voter.display_name).join(', ')
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => choose(option.id)}
              disabled={!canVote || closed}
              aria-pressed={option.mine}
              aria-label={`${option.text}, ${option.count} ${option.count === 1 ? 'vote' : 'votes'}${option.mine ? ', selected' : ''}`}
              title={voterNames || undefined}
              className={`group relative flex min-h-11 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default disabled:opacity-100 ${
                winner
                  ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                  : option.mine
                    ? 'border-[var(--color-accent)] text-[var(--color-accent-hover)]'
                    : 'border-[var(--color-border)] text-[var(--color-text)] hover:border-[var(--color-accent)]'
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 transition-[width] duration-300 ease-out motion-reduce:transition-none ${
                  winner || option.mine
                    ? 'bg-[var(--color-accent-soft)]'
                    : 'bg-[var(--color-panel-2)]'
                }`}
                style={{ width: `${Math.min(100, percentage)}%` }}
              />
              <span className="relative flex min-w-0 flex-1 items-center gap-2">
                {winner ? <CrownIcon /> : <ChoiceMark selected={option.mine} multi={multi} />}
                <span className={`min-w-0 flex-1 break-words text-sm ${winner ? 'font-bold' : 'font-medium'}`}>
                  {option.text}
                </span>
                <VoterStack voters={option.voters} compact={compact} />
                <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--color-text-dim)]">
                  {percentage}% · {option.count}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="text-2xs text-[var(--color-text-faint)]">
        {totalVoters} {totalVoters === 1 ? 'person voted' : 'people voted'}
      </div>
    </div>
  )
}

function VoterStack({ voters, compact }: { voters: PollVoter[]; compact: boolean }) {
  if (voters.length === 0) return null
  const visible = voters.slice(0, compact ? 3 : 5)
  return (
    <span className="flex shrink-0 -space-x-1.5" aria-label={voters.map((v) => v.display_name).join(', ')}>
      {visible.map((voter) => (
        <span key={voter.id} className="rounded-md ring-2 ring-[var(--color-panel)]">
          <Avatar id={voter.id} name={voter.display_name} size={compact ? 18 : 20} />
        </span>
      ))}
      {voters.length > visible.length ? (
        <span className="relative flex h-5 min-w-5 items-center justify-center rounded-md bg-[var(--color-panel)] px-1 text-[9px] font-semibold text-[var(--color-text-faint)] ring-2 ring-[var(--color-panel)]">
          +{voters.length - visible.length}
        </span>
      ) : null}
    </span>
  )
}

function useCountdown(expiresAt: string | null, closed: boolean): string | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!expiresAt || closed) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [expiresAt, closed])
  if (!expiresAt || closed) return null
  const remaining = Math.max(0, new Date(expiresAt).getTime() - now)
  if (remaining === 0) return 'ending now'
  const minutes = Math.ceil(remaining / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  if (days > 0) return `ends in ${days}d${hours ? ` ${hours}h` : ''}`
  if (hours > 0) return `ends in ${hours}h${mins ? ` ${mins}m` : ''}`
  return `ends in ${mins}m`
}

function PollIcon() {
  return (
    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <path d="M5 20V10M12 20V4M19 20v-7" />
      </svg>
    </span>
  )
}

function ChoiceMark({ selected, multi }: { selected: boolean; multi: boolean }) {
  return (
    <span
      aria-hidden
      className={`flex h-4 w-4 shrink-0 items-center justify-center border ${multi ? 'rounded' : 'rounded-full'} ${
        selected
          ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white'
          : 'border-[var(--color-text-faint)]'
      }`}
    >
      {selected ? (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m2.5 6 2.2 2.2L9.5 3.5" />
        </svg>
      ) : null}
    </span>
  )
}

function CrownIcon() {
  return (
    <svg className="shrink-0 text-[var(--color-accent-hover)]" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Winner">
      <path d="m3 7 4 4 5-7 5 7 4-4-2 11H5L3 7Z" />
    </svg>
  )
}
