// Calendar date helpers — the ONLY module allowed to use dayjs. The rest of the
// app stays on native Date; dayjs is confined here for timezone-safe agenda math
// (grouping, month grids, "now" offsets) and human-friendly formatting.

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { CalendarItem } from './types'
import { navigateTo } from './nav'
import { useStore } from '../store'

dayjs.extend(utc)
dayjs.extend(timezone)

export { dayjs }

/** Local-day key (YYYY-MM-DD) for grouping and mini-month selection. */
export function dayKey(iso: string | Date | dayjs.Dayjs): string {
  return dayjs(iso).format('YYYY-MM-DD')
}

/** Human day heading, e.g. "Today", "Tomorrow", or "Mon, Jul 21". */
export function dayHeading(key: string): string {
  const d = dayjs(key)
  const today = dayjs().startOf('day')
  const diff = d.startOf('day').diff(today, 'day')
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return d.format('ddd, MMM D')
}

/** Time range label, e.g. "9:00 – 9:30 AM" or "All day". */
export function timeRange(startIso: string, endIso: string, allDay: boolean): string {
  if (allDay) return 'All day'
  const start = dayjs(startIso)
  const end = dayjs(endIso)
  const sameMeridiem = start.format('A') === end.format('A')
  const startFmt = start.minute() === 0 ? 'h' : 'h:mm'
  const endFmt = end.minute() === 0 ? 'h' : 'h:mm'
  const startLabel = sameMeridiem ? start.format(startFmt) : start.format(`${startFmt} A`)
  return `${startLabel} – ${end.format(`${endFmt} A`)}`
}

export function shortTime(iso: string): string {
  const d = dayjs(iso)
  return d.format(d.minute() === 0 ? 'h A' : 'h:mm A')
}

export type CalendarItemKey = { source: string; id: string }

/** Stable identity for a calendar item (source + id) for React keys / dedupe. */
export function itemKey(item: CalendarItem): string {
  return `${item.source}:${item.id}`
}

export type DayGroup = { key: string; label: string; items: CalendarItem[] }

/** Group calendar items into ascending local-day buckets. */
export function groupByDay(items: CalendarItem[]): DayGroup[] {
  const buckets = new Map<string, CalendarItem[]>()
  const sorted = [...items].sort((a, b) => a.start_at.localeCompare(b.start_at))
  for (const item of sorted) {
    const key = dayKey(item.start_at)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, groupItems]) => ({ key, label: dayHeading(key), items: groupItems }))
}

export type MonthCell = {
  key: string // YYYY-MM-DD
  date: dayjs.Dayjs
  inMonth: boolean
  isToday: boolean
}

/**
 * Build a 6×7 grid (Monday-first weeks) covering the month containing `anchor`.
 * Always returns 42 cells so the grid height is stable.
 */
export function monthGrid(anchor: dayjs.Dayjs): MonthCell[] {
  const firstOfMonth = anchor.startOf('month')
  // dayjs day(): 0=Sun..6=Sat. Shift so Monday=0.
  const offset = (firstOfMonth.day() + 6) % 7
  const gridStart = firstOfMonth.subtract(offset, 'day')
  const today = dayKey(dayjs())
  const cells: MonthCell[] = []
  for (let i = 0; i < 42; i++) {
    const date = gridStart.add(i, 'day')
    const key = date.format('YYYY-MM-DD')
    cells.push({
      key,
      date,
      inMonth: date.month() === anchor.month(),
      isToday: key === today,
    })
  }
  return cells
}

/** Monday-first weekday initials for the mini-month header. */
export const WEEKDAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/**
 * Fractional offset (0..1) of "now" within the given local day, or null when the
 * day is not today — used to place the agenda "now" line.
 */
export function nowOffsetForDay(dayKeyValue: string): number | null {
  const now = dayjs()
  if (dayKey(now) !== dayKeyValue) return null
  const minutes = now.hour() * 60 + now.minute()
  return minutes / (24 * 60)
}

/** True when `now` sits within [start − leadMinutes, end] — gates Join buttons. */
export function withinJoinWindow(
  startIso: string,
  endIso: string,
  leadMinutes = 10,
): boolean {
  const now = dayjs()
  const openAt = dayjs(startIso).subtract(leadMinutes, 'minute')
  return (now.isAfter(openAt) || now.isSame(openAt)) && now.isBefore(dayjs(endIso))
}

/** ISO of the next :00 / :30 boundary, for the schedule modal's default start. */
export function nextHalfHourIso(): string {
  const now = dayjs()
  const minutes = now.minute()
  const add = minutes === 0 ? 0 : minutes <= 30 ? 30 - minutes : 60 - minutes
  return now.add(add, 'minute').second(0).millisecond(0).toISOString()
}

/** RFC3339/ISO → value for a <input type="datetime-local"> (local, no zone). */
export function isoToDatetimeLocal(iso: string): string {
  return dayjs(iso).format('YYYY-MM-DDTHH:mm')
}

/** <input type="datetime-local"> value → RFC3339 ISO (UTC). */
export function datetimeLocalToIso(value: string): string {
  return dayjs(value).toISOString()
}

/** First moment of the local day (UTC ISO) for range params. */
export function startOfDayIso(iso: string | dayjs.Dayjs): string {
  return dayjs(iso).startOf('day').toISOString()
}

export function endOfDayIso(iso: string | dayjs.Dayjs): string {
  return dayjs(iso).endOf('day').toISOString()
}

/**
 * Navigate to (and, for channel calls, join) a scheduled meeting via its
 * server-computed `join_path`:
 *   - `/c/:channelId`   → route into the channel and joinVoice(channelId)
 *   - `/call/:token`    → route to the standalone call page
 * Anything else is treated as a plain navigation.
 */
export function joinScheduledMeeting(joinPath: string | null) {
  if (!joinPath) return
  const channelMatch = joinPath.match(/^\/c\/([^/]+)/)
  if (channelMatch) {
    navigateTo(joinPath)
    void useStore.getState().joinVoice(channelMatch[1])
    return
  }
  navigateTo(joinPath)
}
