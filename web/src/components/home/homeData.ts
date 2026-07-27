// Everything the home board shows, assembled in one place.
//
// Two registers, deliberately kept apart, because they answer different
// questions: **your trail** (what you opened, newest first — `lib/recents.ts`)
// and **the workspace's changes** (unread conversations, docs that moved, tasks
// on your plate, the next thing on the calendar). Mixing them into one "recent"
// list reads as noise; the split is what makes the screen scannable.
//
// Cost discipline: everything except the doc feed and the agenda comes from
// state the shell already loaded at boot, so opening home costs two requests.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { describeRoute, useRecents, type RecentEntry } from '../../lib/recents'
import { byFrecency } from '../../lib/frecency'
import { channelLabel } from '../../lib/util'
import { effectiveNicknames } from '../../lib/displayName'
import { withinJoinWindow } from '../../lib/calendar'
import { useStore } from '../../store'
import type { CalendarItem, Channel, RecentDoc, Task } from '../../lib/types'

const RESUME_MAX = 6
const LANE_MAX = 5

/** Agenda horizon: further out than this is planning, not "up next". */
const UP_NEXT_HOURS = 24

// Home is the chat front door, so it mounts again on every trip back to `/`.
// Without this, bouncing between a channel and home refetches the doc feed and
// the agenda every time; neither changes minute to minute.
const FETCH_TTL_MS = 60_000

type Cached<T> = { at: number; value: T } | null

function fresh<T>(cache: Cached<T>): T | null {
  return cache && Date.now() - cache.at < FETCH_TTL_MS ? cache.value : null
}

/**
 * The trail, with labels refreshed from the store (a channel may have been
 * renamed since) and entries whose object is *known* to be gone dropped. An
 * object the store simply hasn't loaded keeps its stored snapshot — that is the
 * whole reason the snapshot exists.
 */
export function useResume(): RecentEntry[] {
  const trail = useRecents()
  const channels = useStore((s) => s.channels)
  const docMeta = useStore((s) => s.docMeta)
  const nicknames = useStore(effectiveNicknames)

  return useMemo(() => {
    const live = trail.filter((entry) => {
      if (entry.kind === 'channel' || entry.kind === 'dm') {
        return channels.some((channel) => channel.id === entry.id)
      }
      // A doc the store has never heard of is not proof of deletion — only a
      // doc it knows about and marks deleted is.
      const doc = docMeta[entry.id]
      return doc ? !doc.deleted_at : true
    })
    const fresh = live.map((entry) => {
      const now = describeRoute(entry.path)
      return now ? { ...entry, ...now } : entry
    })
    if (fresh.length >= 3) return fresh.slice(0, RESUME_MAX)

    // Cold device, warm habits: a trail this thin says nothing, so fall back to
    // the palette's frecency ranking rather than showing one lonely card.
    const seen = new Set(fresh.map((entry) => entry.id))
    const backfill = byFrecency(
      channels.filter((c) => (c.is_member || c.kind === 'dm') && !seen.has(c.id)),
      (c) => `channel:${c.id}`,
    )
      .filter((c) => c.last_message_at)
      .slice(0, RESUME_MAX - fresh.length)
      .map<RecentEntry>((channel) => ({
        kind: channel.kind === 'dm' ? 'dm' : 'channel',
        id: channel.id,
        path: `/c/${channel.id}`,
        title: channelLabel(channel, nicknames),
        sub: channel.kind === 'dm' ? 'Direct message' : 'Channel',
        priv: channel.kind !== 'public',
        chanId: channel.id,
        at: new Date(channel.last_message_at ?? 0).getTime(),
      }))
    return [...fresh, ...backfill]
  }, [trail, channels, docMeta, nicknames])
}

/** Unread first, then whatever moved most recently. Non-member channels stay out. */
export function useActiveConversations(): Channel[] {
  const channels = useStore((s) => s.channels)
  return useMemo(
    () =>
      channels
        .filter((c) => (c.is_member || c.kind === 'dm') && (c.last_message_at || c.unread_count))
        .sort((a, b) => {
          if (!!a.unread_count !== !!b.unread_count) return a.unread_count ? -1 : 1
          return (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
        })
        .slice(0, LANE_MAX),
    [channels],
  )
}

/** Open tasks assigned to you, most recently touched first. */
export function useMyOpenTasks(): Task[] {
  const myTasks = useStore((s) => s.myTasks)
  const projects = useStore((s) => s.projects)
  return useMemo(() => {
    const closed = new Set(
      projects.flatMap((project) =>
        project.states
          .filter((state) => state.type === 'completed' || state.type === 'canceled')
          .map((state) => state.id),
      ),
    )
    return [...myTasks]
      .filter((task) => !closed.has(task.state_id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, LANE_MAX)
  }, [myTasks, projects])
}

let docsCache: Cached<RecentDoc[]> = null

/** Workspace-wide recently-updated docs, canvases and boards. One request. */
export function useRecentDocs(): { docs: RecentDoc[]; loading: boolean } {
  const cached = fresh(docsCache)
  const [docs, setDocs] = useState<RecentDoc[]>(cached ?? [])
  const [loading, setLoading] = useState(!cached)

  useEffect(() => {
    if (fresh(docsCache)) return
    let live = true
    void api
      .recentDocs(undefined, LANE_MAX)
      .then((result) => {
        const next = result.docs.slice(0, LANE_MAX)
        docsCache = { at: Date.now(), value: next }
        if (live) setDocs(next)
      })
      .catch(() => live && setDocs([]))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [])

  return { docs, loading }
}

let agendaCache: Cached<CalendarItem[]> = null

export type UpNext = {
  item: CalendarItem
  startsInMs: number
  joinable: boolean
  joinPath: string | null
}

/**
 * The single next timed event within the day — the one thing on this screen
 * that expires, so it gets the top strip instead of a lane. All-day entries are
 * excluded: they have no moment to count down to.
 */
export function useUpNext(): UpNext | null {
  const [items, setItems] = useState<CalendarItem[]>(fresh(agendaCache) ?? [])
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (fresh(agendaCache)) return
    let live = true
    const from = new Date().toISOString()
    const to = new Date(Date.now() + UP_NEXT_HOURS * 3600_000).toISOString()
    void api.calendar
      .events(from, to)
      .then((result) => {
        agendaCache = { at: Date.now(), value: result.events }
        if (live) setItems(result.events)
      })
      // Calendar may be unreachable or empty; the strip simply doesn't render.
      .catch(() => live && setItems([]))
    return () => {
      live = false
    }
  }, [])

  // Re-render for the countdown. 30s is fine — the label is minute-grained.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  return useMemo(() => {
    void tick
    const now = Date.now()
    const next = items
      .filter((item) => !item.all_day && new Date(item.end_at).getTime() > now)
      .sort((a, b) => a.start_at.localeCompare(b.start_at))[0]
    if (!next) return null
    const joinPath = next.source === 'native' ? next.join_path : null
    return {
      item: next,
      startsInMs: new Date(next.start_at).getTime() - now,
      joinable: !!joinPath && withinJoinWindow(next.start_at, next.end_at),
      joinPath,
    }
  }, [items, tick])
}
