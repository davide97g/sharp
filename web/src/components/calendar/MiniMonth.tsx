import { useMemo, useState } from 'react'
import { dayjs, monthGrid, WEEKDAY_INITIALS, dayKey } from '../../lib/calendar'

/**
 * Hand-built 7×6 month picker (Monday-start weeks). Days with events show a dot;
 * selecting a day bubbles its YYYY-MM-DD key so the agenda can scroll to it.
 */
export function MiniMonth({
  selectedDate,
  eventDays,
  onSelect,
}: {
  selectedDate: string | null
  eventDays: Set<string>
  onSelect: (dayKey: string) => void
}) {
  const [anchor, setAnchor] = useState(() =>
    dayjs(selectedDate ?? undefined).startOf('month'),
  )
  const cells = useMemo(() => monthGrid(anchor), [anchor])
  const todayKey = dayKey(dayjs())

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-sm font-semibold tracking-tight text-[var(--color-text)]">
          {anchor.format('MMMM YYYY')}
        </span>
        <div className="flex items-center gap-0.5">
          <NavBtn
            label="Previous month"
            onClick={() => setAnchor((a) => a.subtract(1, 'month'))}
          >
            <path d="m15 6-6 6 6 6" />
          </NavBtn>
          <button
            type="button"
            onClick={() => setAnchor(dayjs().startOf('month'))}
            title="Jump to current month"
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            Today
          </button>
          <NavBtn
            label="Next month"
            onClick={() => setAnchor((a) => a.add(1, 'month'))}
          >
            <path d="m9 6 6 6-6 6" />
          </NavBtn>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-0.5 px-1 pb-1">
        {WEEKDAY_INITIALS.map((d, i) => (
          <div
            key={i}
            className="py-1 text-center text-[10px] font-semibold text-[var(--color-text-faint)]"
          >
            {d}
          </div>
        ))}
        {cells.map((cell) => {
          const selected = cell.key === selectedDate
          const hasEvents = eventDays.has(cell.key)
          return (
            <button
              key={cell.key}
              type="button"
              onClick={() => onSelect(cell.key)}
              className={`relative flex h-7 items-center justify-center rounded-md text-xs tabular-nums transition ${
                selected
                  ? 'bg-[var(--color-accent)] font-semibold text-white'
                  : cell.isToday
                    ? 'font-semibold text-[var(--color-accent-hover)] hover:bg-[var(--color-panel-2)]'
                    : cell.inMonth
                      ? 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
                      : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]'
              }`}
              aria-label={cell.date.format('dddd, MMMM D, YYYY')}
              aria-current={cell.key === todayKey ? 'date' : undefined}
            >
              {cell.date.date()}
              {hasEvents && !selected && (
                <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-[var(--color-accent)]" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NavBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  )
}
