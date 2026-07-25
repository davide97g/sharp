import type { Channel, User } from './types'

/**
 * Email is private: only the signed-in user ever sees their own address.
 * Returns the email to render for `user`, or null when it must stay hidden.
 */
export function visibleEmail(user: User, meId: string | null | undefined): string | null {
  return user.id === meId ? (user.email ?? null) : null
}

/** Compare two string-encoded bigint message ids. */
export function cmpId(a: string, b: string): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function maxId(a: string, b: string): string {
  return cmpId(a, b) >= 0 ? a : b
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Compact relative time, e.g. "now", "5m", "3h", "2d", else a date. */
export function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime()
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (secs < 45) return 'now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Message timestamp in the user's chosen style. `hover` shares the clock format
 * with the default — the difference is only *when* the caller reveals it.
 */
export function fmtMessageTime(
  iso: string,
  style: 'hover' | 'clock24' | 'clock12' | 'relative',
): string {
  if (style === 'relative') return fmtRelative(iso)
  const d = new Date(iso)
  if (style === 'clock24' || style === 'clock12') {
    return d.toLocaleTimeString(undefined, {
      hour: style === 'clock12' ? 'numeric' : '2-digit',
      minute: '2-digit',
      hour12: style === 'clock12',
    })
  }
  return fmtTime(iso)
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

/** Human display label for a channel in lists / headers.
 *  Pass `nicknames` so DM peers show the viewer's personal override. */
export function channelLabel(ch: Channel, nicknames?: Record<string, string>): string {
  if (ch.kind === 'dm') {
    const id = ch.dm_user?.id
    if (id && nicknames?.[id]?.trim()) return nicknames[id].trim()
    return ch.dm_user?.display_name ?? 'Direct message'
  }
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

/** First grapheme cluster of a string (keeps ZWJ emoji whole, e.g. 👨‍👩‍👧). */
function firstGrapheme(s: string): string {
  const Seg = (Intl as { Segmenter?: new (locale?: string, opts?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter
  if (Seg) {
    for (const { segment } of new Seg(undefined, { granularity: 'grapheme' }).segment(s)) return segment
  }
  return [...s][0] ?? ''
}

export function initials(name: string): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  const isAlnum = (ch: string) => /[\p{L}\p{N}]/u.test(ch)
  // First alphanumeric code point of a word, skipping any leading symbols/emoji.
  const firstLetter = (word: string): string | null => {
    for (const ch of word) if (isAlnum(ch)) return ch
    return null
  }
  const words = trimmed.split(/\s+/).filter(Boolean)
  const letters = words.map(firstLetter).filter((c): c is string => c !== null)
  // Two or more real words → first + last initial.
  if (letters.length >= 2) return (letters[0] + letters[letters.length - 1]).toUpperCase()
  // Single real word → up to two of its leading alphanumerics.
  if (letters.length === 1) {
    const word = words.find(firstLetter)!
    return [...word].filter(isAlnum).slice(0, 2).join('').toUpperCase()
  }
  // No letters/digits at all — a pure emoji/symbol name. Show its first glyph.
  return firstGrapheme(trimmed)
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

// ── Duration and clock formatting ────────────────────────────────────────────────────
//
// These lived as nine near-identical local helpers across the components that needed
// them, differing only in whether they took seconds or milliseconds and whether they
// rounded up or down. The distinction matters, so both directions are here explicitly
// rather than collapsed into one function that guesses.

/** `m:ss` from seconds. Negative or non-finite input clamps to `0:00`. */
export function fmtClock(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * `m:ss` from milliseconds, rounded **down** — for elapsed time. A recorder should show
 * 0:00 for the first second, not 0:01.
 */
export function fmtClockMs(ms: number): string {
  return fmtClock(ms / 1000)
}

/**
 * `m:ss` from milliseconds, rounded **up** — for a countdown. A remaining time of 500ms
 * must read 0:01, not 0:00, or the label hits zero before the thing it counts does.
 */
export function fmtCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** `45m` / `2h 5m` from whole minutes. Used for meeting lengths. */
export function fmtHoursMinutes(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes))
  if (safe < 60) return `${safe}m`
  return `${Math.floor(safe / 60)}h ${safe % 60}m`
}

/** `45m` / `2h 5m` from milliseconds. */
export function fmtDurationMs(ms: number): string {
  return fmtHoursMinutes(ms / 60_000)
}

/** Locale-aware `Mar 4`. Takes a Date so callers that already parsed one don't re-parse. */
export function fmtShortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Minutes-of-day ↔ "HH:MM" ─────────────────────────────────────────────────────────
//
// Quiet-hours preferences are stored as minutes past local midnight (see
// server/src/routes/prefs.rs), while `<input type="time">` speaks "HH:MM".

/** Minutes past midnight → zero-padded `HH:MM`. */
export function minutesToHhmm(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** `HH:MM` → minutes past midnight. Unparseable input is 0 (midnight), never NaN. */
export function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0
  return h * 60 + m
}
