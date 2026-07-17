import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { dayjs, dayKey, itemKey, startOfWeek, shortTime } from '../../lib/calendar'
import { EventDetail } from './EventDetail'

const HOUR_HEIGHT = 48 // px per hour row
const DAY_HEIGHT = HOUR_HEIGHT * 24
const MIN_EVENT_HEIGHT = 16
const GUTTER = 'w-14' // hour-label gutter width

type PositionedEvent = {
  item: CalendarItem
  topPct: number // 0..100 within the day
  heightPct: number
  col: number
  cols: number
}

type PopoverAnchor = { item: CalendarItem; rect: DOMRect }

/**
 * Google-Calendar-style week grid: 7 Monday-first day columns, 24h time rows,
 * an all-day lane on top, a red "now" line across today's column, and events
 * absolutely positioned by time with side-by-side columns for overlaps. Clicking
 * an event opens the shared EventDetail card in a popover.
 */
export function WeekGrid({
  items,
  selectedDate,
  loading,
}: {
  items: CalendarItem[]
  selectedDate: string | null
  loading: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)

  const weekStart = useMemo(
    () => startOfWeek(selectedDate ?? dayjs()),
    [selectedDate],
  )
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => weekStart.add(i, 'day')),
    [weekStart],
  )
  const todayKey = dayKey(dayjs())

  // Split this week's items into all-day and timed, bucketed by local day key.
  const { allDayByDay, timedByDay } = useMemo(() => {
    const allDayByDay = new Map<string, CalendarItem[]>()
    const timedByDay = new Map<string, CalendarItem[]>()
    const weekEnd = weekStart.add(7, 'day')
    for (const item of items) {
      const start = dayjs(item.start_at)
      if (start.isBefore(weekStart) || !start.isBefore(weekEnd)) continue
      const key = dayKey(item.start_at)
      const map = item.all_day ? allDayByDay : timedByDay
      const bucket = map.get(key)
      if (bucket) bucket.push(item)
      else map.set(key, [item])
    }
    return { allDayByDay, timedByDay }
  }, [items, weekStart])

  const hasAllDay = allDayByDay.size > 0

  // Scroll to ~08:00 once the grid is laid out.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 8 * HOUR_HEIGHT
  }, [])

  // Re-render the "now" line every minute.
  const [, forceTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  // Close popover on scroll / resize (its anchor rect goes stale).
  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    const scroller = scrollRef.current
    scroller?.addEventListener('scroll', close)
    window.addEventListener('resize', close)
    return () => {
      scroller?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
    }
  }, [anchor])

  const now = dayjs()
  const nowPct = ((now.hour() * 60 + now.minute()) / (24 * 60)) * 100

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-faint)]">
        Loading week…
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Day headers */}
      <div className="flex border-b border-[var(--color-border)]">
        <div className={`${GUTTER} shrink-0`} />
        {days.map((d) => {
          const isToday = dayKey(d) === todayKey
          return (
            <div
              key={d.toISOString()}
              className="flex flex-1 flex-col items-center py-1.5"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                {d.format('ddd')}
              </span>
              <span
                className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums ${
                  isToday
                    ? 'bg-[var(--color-accent)] font-semibold text-white'
                    : 'text-[var(--color-text-dim)]'
                }`}
              >
                {d.date()}
              </span>
            </div>
          )
        })}
      </div>

      {/* All-day lane */}
      {hasAllDay && (
        <div className="flex border-b border-[var(--color-border)]">
          <div
            className={`${GUTTER} shrink-0 py-1 pr-1 text-right text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]`}
          >
            All day
          </div>
          {days.map((d) => {
            const dayItems = allDayByDay.get(dayKey(d)) ?? []
            return (
              <div
                key={d.toISOString()}
                className="min-w-0 flex-1 space-y-0.5 border-l border-[var(--color-border)] p-0.5"
              >
                {dayItems.map((item) => (
                  <AllDayChip
                    key={itemKey(item)}
                    item={item}
                    onOpen={(rect) => setAnchor({ item, rect })}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex" style={{ height: DAY_HEIGHT }}>
          {/* Hour gutter */}
          <div className={`${GUTTER} relative shrink-0`}>
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="absolute right-1 -translate-y-1/2 text-[10px] tabular-nums text-[var(--color-text-faint)]"
                style={{ top: h * HOUR_HEIGHT }}
              >
                {h === 0 ? '' : dayjs().hour(h).minute(0).format('h A')}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d) => {
            const key = dayKey(d)
            const positioned = layoutDay(timedByDay.get(key) ?? [], d)
            const isToday = key === todayKey
            return (
              <div
                key={d.toISOString()}
                className="relative min-w-0 flex-1 border-l border-[var(--color-border)]"
              >
                {/* Hour gridlines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-[var(--color-border)]/60"
                    style={{ top: h * HOUR_HEIGHT }}
                  />
                ))}

                {/* Events */}
                {positioned.map((pe) => (
                  <WeekEvent
                    key={itemKey(pe.item)}
                    pe={pe}
                    active={anchor?.item === pe.item}
                    onOpen={(rect) => setAnchor({ item: pe.item, rect })}
                  />
                ))}

                {/* Now line */}
                {isToday && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-20"
                    style={{ top: `${nowPct}%` }}
                    aria-label="Current time"
                  >
                    <div className="relative">
                      <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-[#ff6b5f]" />
                      <div className="h-px bg-[#ff6b5f]" />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {anchor && (
        <WeekPopover anchor={anchor} onClose={() => setAnchor(null)} />
      )}
    </div>
  )
}

function AllDayChip({
  item,
  onOpen,
}: {
  item: CalendarItem
  onOpen: (rect: DOMRect) => void
}) {
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = item.source === 'native' && item.meeting.status === 'cancelled'
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
      style={{ background: `color-mix(in srgb, ${accent} 22%, transparent)` }}
      className={`flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] text-[var(--color-text)] hover:brightness-110 ${
        cancelled ? 'line-through opacity-60' : ''
      }`}
    >
      <span
        aria-hidden
        className="h-3 w-0.5 shrink-0 rounded-full"
        style={{ background: accent }}
      />
      <span className="truncate">{item.title || 'Untitled'}</span>
    </button>
  )
}

function WeekEvent({
  pe,
  active,
  onOpen,
}: {
  pe: PositionedEvent
  active: boolean
  onOpen: (rect: DOMRect) => void
}) {
  const { item } = pe
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = item.source === 'native' && item.meeting.status === 'cancelled'
  const gap = 2 // px between side-by-side columns
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect())}
      style={{
        top: `${pe.topPct}%`,
        height: `max(${pe.heightPct}%, ${MIN_EVENT_HEIGHT}px)`,
        left: `calc(${(pe.col / pe.cols) * 100}% + 1px)`,
        width: `calc(${(1 / pe.cols) * 100}% - ${gap + 1}px)`,
        background: `color-mix(in srgb, ${accent} 20%, var(--color-panel))`,
        borderLeft: `2px solid ${accent}`,
      }}
      className={`absolute z-10 overflow-hidden rounded-md px-1 py-0.5 text-left transition hover:z-20 hover:brightness-110 ${
        cancelled ? 'opacity-60' : ''
      } ${active ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
    >
      <div
        className={`truncate text-[11px] font-medium leading-tight text-[var(--color-text)] ${
          cancelled ? 'line-through' : ''
        }`}
      >
        {item.title || 'Untitled'}
      </div>
      {pe.heightPct > 4 && (
        <div className="truncate text-[10px] leading-tight text-[var(--color-text-faint)]">
          {shortTime(item.start_at)}
        </div>
      )}
    </button>
  )
}

/** Fixed-position popover anchored near the clicked event, closing on outside click / Escape. */
function WeekPopover({
  anchor,
  onClose,
}: {
  anchor: PopoverAnchor
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const WIDTH = 288 // w-72
  const [pos, setPos] = useState<{ top: number; left: number }>(() => ({
    top: anchor.rect.bottom + 6,
    left: anchor.rect.left,
  }))

  useLayoutEffect(() => {
    const el = ref.current
    const margin = 8
    const height = el?.offsetHeight ?? 0
    let left = anchor.rect.right + 6
    if (left + WIDTH + margin > window.innerWidth) {
      left = anchor.rect.left - WIDTH - 6
    }
    if (left < margin) left = Math.max(margin, window.innerWidth - WIDTH - margin)
    let top = anchor.rect.top
    if (top + height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - height - margin)
    }
    setPos({ top, left })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-40 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-2xl"
      style={{ top: pos.top, left: pos.left }}
    >
      <EventDetail item={anchor.item} />
    </div>
  )
}

/**
 * Position timed events within a single day column and assign side-by-side
 * columns for overlaps. Returns percentage-based offsets (0..100) so the block
 * scales with the column height.
 */
function layoutDay(items: CalendarItem[], day: dayjs.Dayjs): PositionedEvent[] {
  const dayStart = day.startOf('day')
  type Ev = { item: CalendarItem; start: number; end: number }
  const evs: Ev[] = items
    .map((item) => {
      const s = dayjs(item.start_at)
      const e = dayjs(item.end_at)
      const startMin = Math.max(0, s.diff(dayStart, 'minute'))
      const endMin = Math.min(24 * 60, Math.max(startMin + 1, e.diff(dayStart, 'minute')))
      return { item, start: startMin, end: endMin }
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const result: PositionedEvent[] = []
  let cluster: Ev[] = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (cluster.length === 0) return
    const columnEnds: number[] = []
    const placed = cluster.map((ev) => {
      let col = columnEnds.findIndex((end) => end <= ev.start)
      if (col === -1) {
        col = columnEnds.length
        columnEnds.push(ev.end)
      } else {
        columnEnds[col] = ev.end
      }
      return { ev, col }
    })
    const cols = columnEnds.length
    for (const p of placed) {
      result.push({
        item: p.ev.item,
        topPct: (p.ev.start / (24 * 60)) * 100,
        heightPct: ((p.ev.end - p.ev.start) / (24 * 60)) * 100,
        col: p.col,
        cols,
      })
    }
    cluster = []
  }

  for (const ev of evs) {
    if (cluster.length && ev.start >= clusterEnd) flush()
    cluster.push(ev)
    clusterEnd = Math.max(clusterEnd, ev.end)
  }
  flush()
  return result
}
