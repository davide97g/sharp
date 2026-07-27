// The trail of what you actually opened, so the home screen can offer it back.
//
// Related to `frecency.ts` but answering a different question. Frecency ranks by
// *habit* ("what do you reach for") and only sees quick-switcher picks, which is
// right for the palette and wrong for "pick up where you left off" — that one is
// pure recency, and it has to count every way you can arrive somewhere (sidebar
// click, chat chip, deep link, browser back).
//
// Device-local for the same reasons frecency is: it writes on every navigation,
// it means nothing on your other machine, and the synced `ui` blob has an 8 KB
// ceiling. Entries carry a snapshot of their label so the rail can render before
// (or without) the channel's docs being loaded; when the store does know better,
// the reader re-resolves and the snapshot is only a fallback.

import { useEffect, useState } from 'react'
import { KEYS, readLocalJson, writeLocalJson } from './localPrefs'
import { useStore } from '../store'
import { effectiveNicknames } from './displayName'
import { channelLabel } from './util'

export type RecentKind = 'channel' | 'dm' | 'doc' | 'canvas' | 'board' | 'task'

export type RecentEntry = {
  kind: RecentKind
  /** Route id: channel/doc UUID, or a task identifier like `SHARP-12`. */
  id: string
  /** Where to go back to. Stored so the rail never re-derives routing rules. */
  path: string
  title: string
  sub: string
  /** Author-chosen emoji on a doc/canvas/board; the kind glyph is used without it. */
  icon?: string
  /** Label must blur under the privacy shield (DMs, private channels). */
  priv?: boolean
  /** Channel this entry belongs to, so a per-conversation reveal can unblur it. */
  chanId?: string
  at: number
}

const MAX_ENTRIES = 24

// Only a visit you stayed in counts. Without this, passing through a channel on
// the way somewhere else — or a redirect — would outrank the thing you actually
// worked in.
const DWELL_MS = 2500

let trail: RecentEntry[] | null = null

function load(): RecentEntry[] {
  if (!trail) trail = readLocalJson<RecentEntry[]>(KEYS.recents, [])
  return trail
}

export function getRecents(): RecentEntry[] {
  return load()
}

export function recordRecent(entry: Omit<RecentEntry, 'at'>) {
  const next = [
    { ...entry, at: Date.now() },
    ...load().filter((e) => !(e.kind === entry.kind && e.id === entry.id)),
  ].slice(0, MAX_ENTRIES)
  trail = next
  // Storage failure just means the rail is empty next launch.
  writeLocalJson(KEYS.recents, next)
}

export function clearRecents() {
  trail = []
  writeLocalJson(KEYS.recents, [])
}

/**
 * Resolve a pathname to the thing it shows, or null if it isn't a resumable
 * object (module hubs, settings, search — those are places, not work).
 *
 * Returns null too when the object's label isn't loaded yet; the caller retries
 * on the next navigation rather than storing an "Untitled" the user won't
 * recognize.
 */
export function describeRoute(pathname: string): Omit<RecentEntry, 'at'> | null {
  const state = useStore.getState()
  const [, head, a, b] = pathname.split('/')

  if (head === 'c' && a) {
    const channel = state.channels.find((c) => c.id === a)
    if (!channel) return null
    const dm = channel.kind === 'dm'
    return {
      kind: dm ? 'dm' : 'channel',
      id: channel.id,
      path: `/c/${channel.id}`,
      title: channelLabel(channel, effectiveNicknames(state)),
      sub: dm ? 'Direct message' : channel.kind === 'private' ? 'Private channel' : 'Channel',
      priv: dm || channel.kind === 'private',
      chanId: channel.id,
    }
  }

  const docKinds: Record<string, { kind: RecentKind; label: string }> = {
    d: { kind: 'doc', label: 'Doc' },
    x: { kind: 'canvas', label: 'Canvas' },
    b: { kind: 'board', label: 'Board' },
  }
  const docRoute = docKinds[head ?? '']
  if (docRoute && a) {
    // `docMeta` is the superset: channel doc lists write into it too, and it is
    // the only place a doc opened straight from a deep link lands.
    const doc = state.docMeta[a]
    if (!doc || doc.deleted_at) return null
    const channel = state.channels.find((c) => c.id === doc.channel_id)
    return {
      kind: docRoute.kind,
      id: doc.id,
      path: `/${head}/${doc.id}`,
      title: doc.title || 'Untitled',
      sub: channel ? `${docRoute.label} · #${channel.name}` : docRoute.label,
      icon: doc.icon || undefined,
      priv: channel ? channel.kind !== 'public' : false,
      chanId: doc.channel_id,
    }
  }

  // `/t/:key/:num` is a task; `/t/:key` alone is the project board, which is a
  // place rather than a piece of work.
  if (head === 't' && a && b) {
    const identifier = `${a.toUpperCase()}-${b}`
    const task = [...state.myTasks, ...Object.values(state.tasksByProject).flat()].find(
      (t) => t.identifier === identifier,
    )
    if (!task) return null
    return {
      kind: 'task',
      id: identifier,
      path: `/t/${a}/${b}`,
      title: task.title || identifier,
      sub: identifier,
    }
  }

  return null
}

/**
 * Single writer for the trail: one effect on the shell's current pathname, so
 * no view has to remember to log itself. Mirrors how the mode rail derives
 * everything it needs from the same pathname.
 */
export function useRecentTracker(pathname: string) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const entry = describeRoute(pathname)
      if (entry) recordRecent(entry)
    }, DWELL_MS)
    return () => window.clearTimeout(timer)
  }, [pathname])
}

/** Read the trail once per mount. Home remounts on every return to `/`. */
export function useRecents(): RecentEntry[] {
  const [entries] = useState(getRecents)
  return entries
}
