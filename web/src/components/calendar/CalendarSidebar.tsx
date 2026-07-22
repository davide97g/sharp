import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { dayKey, dayjs } from '../../lib/calendar'
import { MiniMonth } from './MiniMonth'
import { ScheduleMeetingModal } from './ScheduleMeetingModal'

export function CalendarSidebar() {
  const connections = useStore((s) => s.calendarConnections)
  const loadCalendarConnections = useStore((s) => s.loadCalendarConnections)
  const items = useStore((s) => s.calendarItems)
  const selectedDate = useStore((s) => s.calendarSelectedDate)
  const setSelectedDate = useStore((s) => s.setCalendarSelectedDate)
  const calendarRange = useStore((s) => s.calendarRange)
  const loadCalendar = useStore((s) => s.loadCalendar)
  const navigate = useNavigate()
  const location = useLocation()

  const [scheduling, setScheduling] = useState(false)
  const [busyCal, setBusyCal] = useState<string | null>(null)

  useEffect(() => {
    void loadCalendarConnections()
  }, [loadCalendarConnections])

  const eventDays = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) set.add(dayKey(item.start_at))
    return set
  }, [items])

  async function toggleCalendar(id: string, selected: boolean) {
    setBusyCal(id)
    try {
      await api.calendar.setCalendarSelected(id, selected)
      await loadCalendarConnections()
      if (calendarRange) await loadCalendar(calendarRange.from, calendarRange.to)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update calendar.')
    } finally {
      setBusyCal(null)
    }
  }

  const allCalendars = connections.flatMap((c) => c.calendars)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]">
          <CalendarIcon />
        </span>
        <span className="font-bold tracking-tight">Calendar</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() => setScheduling(true)}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)]"
          >
            <PlusIcon /> New meeting
          </button>

          <MiniMonth
            selectedDate={selectedDate ?? dayKey(dayjs())}
            eventDays={eventDays}
            onSelect={setSelectedDate}
          />
        </div>

        <div className="mt-4 border-t border-[var(--color-border)] px-3 py-3">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
            Calendars
          </h2>

          <div className="mb-2 flex items-center gap-2 rounded-md px-1 py-1 text-sm">
            <span
              aria-hidden
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ background: 'var(--color-accent)' }}
            />
            <span className="text-[var(--color-text-dim)]">sharp meetings</span>
          </div>

          {allCalendars.map((cal) => (
            <label
              key={cal.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-panel-2)]"
            >
              <input
                type="checkbox"
                checked={cal.selected}
                disabled={busyCal === cal.id}
                onChange={(e) => void toggleCalendar(cal.id, e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-accent)]"
              />
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: cal.color ?? 'var(--color-text-faint)' }}
              />
              <span className="truncate text-[var(--color-text-dim)]">
                {cal.summary || 'Calendar'}
              </span>
            </label>
          ))}
        </div>

        <div className="border-t border-[var(--color-border)] px-3 py-3">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
            Accounts
          </h2>
          {connections.length === 0 ? (
            <button
              type="button"
              onClick={() => navigate('/settings/accounts', { state: { from: `${location.pathname}${location.search}` } })}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            >
              Connect Google
            </button>
          ) : (
            <div className="space-y-1.5">
              {connections.map((conn) => (
                <button
                  key={conn.id}
                  type="button"
                  onClick={() => navigate('/settings/accounts', { state: { from: `${location.pathname}${location.search}` } })}
                  className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-[var(--color-panel-2)]"
                >
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      conn.status === 'active' ? 'bg-[#66c7aa]' : 'bg-[#ff6b5f]'
                    }`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]">
                    {conn.provider_email}
                  </span>
                  {conn.status === 'invalid' && (
                    <span className="shrink-0 text-[10px] font-semibold text-[#ff8a80]">
                      Reconnect
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {scheduling && <ScheduleMeetingModal onClose={() => setScheduling(false)} />}
    </aside>
  )
}

function CalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
