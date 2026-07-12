import type { Channel } from './types'

/** Compare two string-encoded bigint message ids. */
export function cmpId(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function maxId(a: string, b: string): string {
  return cmpId(a, b) >= 0 ? a : b
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function fmtDayDivider(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a)
  const db = new Date(b)
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  )
}

export function withinMinutes(a: string, b: string, minutes: number): boolean {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= minutes * 60000
}

/** Human display label for a channel in lists / headers. */
export function channelLabel(ch: Channel): string {
  if (ch.kind === 'dm') return ch.dm_user?.display_name ?? 'Direct message'
  return ch.name
}

/** Lightweight subsequence fuzzy match; returns a score (higher = better) or -1. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (q.length === 0) return 0
  let ti = 0
  let score = 0
  let streak = 0
  let prevMatchIdx = -1
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    let found = -1
    for (let j = ti; j < t.length; j++) {
      if (t[j] === c) {
        found = j
        break
      }
    }
    if (found === -1) return -1
    // bonuses: consecutive match, start of word/string
    if (found === prevMatchIdx + 1) streak += 1
    else streak = 0
    score += 1 + streak
    if (found === 0 || t[found - 1] === ' ' || t[found - 1] === '-') score += 2
    prevMatchIdx = found
    ti = found + 1
  }
  // shorter targets rank higher on equal match
  score += Math.max(0, 10 - t.length / 5)
  return score
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

/**
 * Deterministic vivid color for a collaborator cursor, keyed by user id.
 * Returned as hex (#rrggbb) — BlockNote's Yjs cursor plugin rejects `hsl()`
 * ("unsupported color format"), and hex works everywhere else too.
 */
export function userColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return hslToHex(h % 360, 70, 60)
}

/** Convert HSL (h in degrees, s/l in percent) to a #rrggbb hex string. */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const a = sn * Math.min(ln, 1 - ln)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Deterministic accent color for an avatar based on id. */
export function avatarColor(id: string): string {
  const palette = [
    '#7c6cff',
    '#5c9bff',
    '#4fbf9f',
    '#e0913a',
    '#e05a7d',
    '#b06cff',
    '#4bb0d6',
    '#c9b03a',
  ]
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
