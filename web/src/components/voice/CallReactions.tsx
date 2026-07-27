// In-call reactions: the control that sends one, and the stream that shows them.
//
// Contract: docs/arch/04-voice.md (`voice.react` / `voice.reaction`).
//
// Two halves, deliberately in one file — they are one feature and share the emoji
// vocabulary:
//   - `ReactionControl` — a call-bar button over a popover: eight quick emoji that
//     re-order themselves around what you actually send, and a search field for
//     anything else.
//   - `CallReactionStream` — the overlay. Reactions rise from the bottom-left of the
//     stage with the sender's name attached, then expire on their own (the feed in
//     lib/callReactions.ts owns the TTL, so nothing here has to clean up).
//
// The stream is `pointer-events: none` end to end: a reaction must never eat a click
// meant for the video under it.

import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  callReactions,
  quickReactions,
  recentReactions,
  type LiveReaction,
} from '../../lib/callReactions'
import { searchEmojis } from '../../lib/emoji'
import { useStore } from '../../store'
import { SearchInput, useDismiss } from '../../ui'

export function CallReactionStream({
  channelId,
  resolveName,
  compact = false,
}: {
  channelId: string
  resolveName: (userId: string, roomName?: string) => string
  compact?: boolean
}) {
  const all = useSyncExternalStore(callReactions.subscribe, callReactions.snapshot)
  const live = useMemo(
    () => all.filter((reaction: LiveReaction) => reaction.channelId === channelId),
    [all, channelId],
  )
  if (live.length === 0) return null

  return (
    <div
      // Announced politely: a screen reader user hears "Ada reacted 🎉" once.
      aria-live="polite"
      // Bounded to the stage body (inset-y-0 + overflow-hidden) so a rising emoji
      // never adds scroll to the panel it is flying over.
      className="pointer-events-none absolute inset-y-0 left-1 z-10 flex w-64 flex-col justify-end overflow-hidden"
    >
      {live.map((reaction) => (
        <div
          key={reaction.id}
          className="call-reaction absolute bottom-0 left-2 flex items-center gap-2"
          style={{ '--drift': `${reaction.drift}px` } as React.CSSProperties}
        >
          <span aria-hidden className={compact ? 'text-3xl' : 'text-4xl'}>
            {reaction.emoji}
          </span>
          <span className="max-w-36 truncate rounded-full bg-black/55 px-2 py-0.5 text-2xs font-medium text-white backdrop-blur-sm">
            {resolveName(reaction.userId, reaction.name)}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ReactionControl({
  size = 'md',
  disabled = false,
}: {
  size?: 'md' | 'lg'
  disabled?: boolean
}) {
  const sendVoiceReaction = useStore((s) => s.sendVoiceReaction)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Read once per opening: the row must not reshuffle under the finger mid-burst.
  const [quick, setQuick] = useState<string[]>(() => quickReactions(recentReactions()))
  const rootRef = useRef<HTMLDivElement>(null)

  useDismiss({ ref: rootRef, onClose: () => setOpen(false), enabled: open })

  const results = query.trim() ? searchEmojis(query, 24) : []
  const dim = size === 'lg' ? 'h-12 w-12' : 'h-11 w-11'

  function openPicker() {
    setQuick(quickReactions(recentReactions()))
    setQuery('')
    setOpen(true)
  }

  function send(emoji: string) {
    sendVoiceReaction(emoji)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative flex">
      <button
        type="button"
        aria-label="Send a reaction"
        title="Send a reaction"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPicker())}
        className={`flex ${dim} shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-[transform,background-color] duration-150 ease-out active:scale-95 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100 ${
          open
            ? 'bg-accent text-white'
            : 'bg-panel-2 text-text hover:bg-border'
        }`}
      >
        <ReactionIcon />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Reactions"
          className="absolute bottom-full left-1/2 z-(--z-dropdown) mb-2 w-[min(20rem,calc(100vw-1.5rem))] -translate-x-1/2 rounded-2xl border border-border bg-panel p-2 shadow-2xl"
        >
          <div className="flex items-center justify-between gap-1">
            {quick.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`React with ${emoji}`}
                onClick={() => send(emoji)}
                className="reaction-palette-item flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-2xl outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent"
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="mt-2 border-t border-border-soft pt-2">
            <SearchInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Any emoji — search “party”"
              aria-label="Search emoji"
            />
            {query.trim() ? (
              results.length > 0 ? (
                <div className="mt-2 grid max-h-40 grid-cols-8 gap-0.5 overflow-y-auto">
                  {results.map((match) => (
                    <button
                      key={match.id}
                      type="button"
                      aria-label={`React with ${match.name}`}
                      title={match.name}
                      onClick={() => send(match.native)}
                      className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-xl outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {match.native}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 px-1 pb-1 text-2xs text-text-faint">
                  No emoji matches “{query.trim()}”.
                </p>
              )
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

// A smiling face with a small burst — reaction, not "emoji picker".
function ReactionIcon() {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M20.9 13a9 9 0 1 1-8.4-9.9" />
      <path d="M8.5 14.5a4.5 4.5 0 0 0 6.6.3" />
      <path d="M9 9.5h.01M15 9h.01" />
      <path d="M19 2v4M17 4h4" />
    </svg>
  )
}
