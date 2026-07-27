// In-call emoji reactions ("Meet-style"): they fly up the stage once and vanish.
//
// Why this lives OUTSIDE the zustand store, like lib/annotations.ts: a reaction is
// pure ephemera with a timer attached. Putting a TTL-pruned list in the store would
// mean a store write per expiry — for state nothing but the overlay reads. Here the
// overlay subscribes, renders, and lets entries age out.
//
// Entries carry their room id, so a stale reaction from the call you just left can
// never surface in the next one. That is also why there is no reset() to call from
// the join/leave paths.

import { KEYS, readLocalJson, writeLocalJson } from './localPrefs'

/** How long one reaction stays on screen — matches `.call-reaction` in index.css. */
export const REACTION_TTL_MS = 3200

/** Nothing renders more than this many at once, however hard a room mashes. */
const MAX_LIVE = 24

export type LiveReaction = {
  /** Unique per burst; the React key. */
  id: number
  channelId: string
  connId: string
  userId: string
  name: string
  emoji: string
  at: number
  /** Horizontal drift (px) so simultaneous reactions fan out rather than stack. */
  drift: number
}

type Incoming = {
  channelId: string
  connId: string
  userId: string
  name: string
  emoji: string
}

class CallReactionFeed {
  private live: LiveReaction[] = []
  private listeners = new Set<() => void>()
  private nextId = 1
  private sweep: ReturnType<typeof setTimeout> | null = null

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Add one reaction (local echo or a relayed peer event). */
  push(incoming: Incoming): void {
    const id = this.nextId++
    // Deterministic spread from the id: no RNG, still no two neighbours aligned.
    const drift = (((id * 37) % 11) - 5) * 9
    this.live = [
      ...this.live.slice(Math.max(0, this.live.length - (MAX_LIVE - 1))),
      { id, ...incoming, at: Date.now(), drift },
    ]
    this.scheduleSweep()
    this.notify()
  }

  private scheduleSweep(): void {
    if (this.sweep !== null) return
    this.sweep = setTimeout(() => {
      this.sweep = null
      const now = Date.now()
      const kept = this.live.filter((reaction) => now - reaction.at < REACTION_TTL_MS)
      if (kept.length !== this.live.length) {
        this.live = kept
        this.notify()
      }
      if (this.live.length > 0) this.scheduleSweep()
    }, REACTION_TTL_MS / 4)
  }

  /**
   * Current reactions for one room, oldest first. Stable reference between
   * changes so `useSyncExternalStore` does not loop.
   */
  snapshot = (): LiveReaction[] => this.live
}

export const callReactions = new CallReactionFeed()

/** Same sliding window the server enforces, mirrored so a local echo never lies. */
const SEND_WINDOW_MS = 2000
const MAX_SENDS_PER_WINDOW = 5
const sends: number[] = []

/** Whether a reaction may be sent right now, consuming a slot when it may. */
export function allowLocalReaction(now = Date.now()): boolean {
  while (sends.length > 0 && now - sends[0] >= SEND_WINDOW_MS) sends.shift()
  if (sends.length >= MAX_SENDS_PER_WINDOW) return false
  sends.push(now)
  return true
}

/** The starter set, in the order Meet-trained hands expect to find them. */
export const DEFAULT_REACTIONS = ['👍', '❤️', '🎉', '👏', '😂', '😮', '🤔', '🔥'] as const

/**
 * The eight-slot quick row: what this person actually uses, then the defaults
 * filling in behind. Recents lead so the row tunes itself to a team's habits.
 */
export function quickReactions(recents: string[]): string[] {
  const row: string[] = []
  for (const emoji of [...recents, ...DEFAULT_REACTIONS]) {
    if (!row.includes(emoji)) row.push(emoji)
    if (row.length === 8) break
  }
  return row
}

const MAX_RECENTS = 8

/** Recently sent emoji, newest first. Device-local: it is muscle memory, not a setting. */
export function recentReactions(): string[] {
  const stored = readLocalJson<unknown>(KEYS.callReactionsRecent, [])
  if (!Array.isArray(stored)) return []
  return stored.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENTS)
}

export function rememberReaction(emoji: string): void {
  const next = [emoji, ...recentReactions().filter((entry) => entry !== emoji)].slice(
    0,
    MAX_RECENTS,
  )
  writeLocalJson(KEYS.callReactionsRecent, next)
}
