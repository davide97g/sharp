import { useEffect, useRef, useState, type ReactNode } from 'react'
import { sound } from '../lib/sound'
import { useStore } from '../store'
import { PollView, pollToViewModel } from './PollView'

export function PollCard({ id, fallbackQuestion }: { id: string; fallbackQuestion: string }) {
  const poll = useStore((s) => s.pollsById[id])
  const fetchPoll = useStore((s) => s.fetchPoll)
  const votePoll = useStore((s) => s.votePoll)
  const closePoll = useStore((s) => s.closePoll)
  const pinPoll = useStore((s) => s.pinPoll)
  const deletePoll = useStore((s) => s.deletePoll)
  const meId = useStore((s) => s.me?.id ?? null)
  const channel = useStore((s) =>
    poll ? s.channels.find((item) => item.id === poll.channel_id) : undefined,
  )
  const [unavailable, setUnavailable] = useState(false)
  const requested = useRef(false)
  const sawOpen = useRef(false)

  useEffect(() => {
    if (poll || requested.current) return
    requested.current = true
    void fetchPoll(id).catch(() => setUnavailable(true))
  }, [fetchPoll, id, poll])

  useEffect(() => {
    if (!poll) return
    if (!poll.closed_at) {
      sawOpen.current = true
    } else if (sawOpen.current) {
      sawOpen.current = false
      sound.toastSuccess()
    }
  }, [poll?.closed_at, poll])

  if (!poll) {
    return (
      <span className="my-1 inline-flex rounded-full border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2.5 py-1 text-xs text-[var(--color-text-dim)]">
        📊 {unavailable ? fallbackQuestion || 'Poll unavailable' : fallbackQuestion || 'Loading poll…'}
      </span>
    )
  }

  const isCreator = meId === poll.creator_id
  const canManage = isCreator || channel?.my_role === 'owner'
  const open = !poll.closed_at

  return (
    <div className="my-1 max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3">
      <PollView {...pollToViewModel(poll, (optionIds) => void votePoll(poll.id, optionIds))} />
      {(canManage || isCreator) && (
        <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-[var(--color-border)] pt-2">
          {canManage && open ? (
            <>
              <ActionButton onClick={() => void closePoll(poll.id)}>Close poll</ActionButton>
              <ActionButton onClick={() => void pinPoll(poll.id, !poll.pinned)}>
                {poll.pinned ? 'Unpin' : 'Pin'}
              </ActionButton>
            </>
          ) : null}
          {isCreator ? (
            <ActionButton
              danger
              onClick={() => {
                if (window.confirm('Delete this poll? This also removes its chat card.')) {
                  void deletePoll(poll.id)
                }
              }}
            >
              Delete
            </ActionButton>
          ) : null}
        </div>
      )}
    </div>
  )
}

function ActionButton({
  children,
  onClick,
  danger = false,
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-9 rounded-md px-2.5 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        danger
          ? 'ml-auto text-red-400 hover:bg-red-500/10'
          : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
