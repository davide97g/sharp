import { useEffect, useMemo, useRef } from 'react'
import type { CalendarItem } from '../../lib/types'
import { dayjs, groupByDay, itemKey, dayKey } from '../../lib/calendar'
import { EventPill } from './EventPill'

/**
 * Scrollable, day-grouped agenda. Each day is a section with a sticky divider;
 * today's section shows a "now" line between past and upcoming events. When
 * `selectedDate` changes the matching section is scrolled into view.
 */
export function AgendaList({
  items,
  selectedDate,
  loading,
}: {
  items: CalendarItem[]
  selectedDate: string | null
  loading: boolean
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const dayRefs = useRef<Map<string, HTMLElement>>(new Map())
  const groups = useMemo(() => groupByDay(items), [items])
  const todayKey = dayKey(dayjs())

  useEffect(() => {
    if (!selectedDate) return
    const el = dayRefs.current.get(selectedDate)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedDate, groups])

  if (loading && items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-faint)]">
        Loading agenda…
      </div>
    )
  }

  if (groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-panel-2)] text-xl">
          📅
        </div>
        <h3 className="font-medium text-[var(--color-text)]">Nothing scheduled</h3>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-faint)]">
          Connect Google Calendar or create a meeting to fill your agenda.
        </p>
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mx-auto max-w-2xl space-y-6">
        {groups.map((group) => (
          <section
            key={group.key}
            ref={(el) => {
              if (el) dayRefs.current.set(group.key, el)
              else dayRefs.current.delete(group.key)
            }}
            className="scroll-mt-4"
          >
            <div className="mb-2 flex items-center gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
                {group.label}
              </h2>
              <span className="text-[11px] text-[var(--color-text-faint)]">
                {dayjs(group.key).format('MMM D')}
              </span>
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <div className="space-y-1.5">
              {group.key === todayKey
                ? withNowLine(group.items)
                : group.items.map((item) => (
                    <EventPill key={itemKey(item)} item={item} />
                  ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

/** Render today's events with a "now" line before the first upcoming event. */
function withNowLine(items: CalendarItem[]) {
  const now = dayjs()
  const nodes: React.ReactNode[] = []
  let placed = false
  for (const item of items) {
    if (!placed && dayjs(item.start_at).isAfter(now)) {
      nodes.push(<NowLine key="now-line" />)
      placed = true
    }
    nodes.push(<EventPill key={itemKey(item)} item={item} />)
  }
  if (!placed) nodes.push(<NowLine key="now-line" />)
  return nodes
}

function NowLine() {
  return (
    <div className="flex items-center gap-2 py-0.5" aria-label="Current time">
      <span className="h-2 w-2 shrink-0 rounded-full bg-[#ff6b5f]" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[#ff8a80]">
        {dayjs().format('h:mm A')}
      </span>
      <div className="h-px flex-1 bg-[#ff6b5f]/40" />
    </div>
  )
}
