import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { toastError, toastInfo } from '../../lib/toast'
import { dayjs, dayKey, dayHeading, startOfWeek, weekHeading } from '../../lib/calendar'
import { AgendaList } from './AgendaList'
import { WeekGrid } from './WeekGrid'
import { ScheduleMeetingModal } from './ScheduleMeetingModal'

// Rolling window that mirrors the server's sync range (-30d / +90d).
function windowRange() {
  return {
    from: dayjs().subtract(30, 'day').startOf('day').toISOString(),
    to: dayjs().add(90, 'day').endOf('day').toISOString(),
  }
}

type ViewMode = 'day' | 'week'
const VIEW_KEY = 'sharp.calendarView'

function initialView(): ViewMode {
  if (window.matchMedia('(max-width: 800px)').matches) return 'day'
  return localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'day'
}

export function CalendarView() {
  const { date } = useParams<{ date: string }>()
  const items = useStore((s) => s.calendarItems)
  const selectedDate = useStore((s) => s.calendarSelectedDate)
  const setSelectedDate = useStore((s) => s.setCalendarSelectedDate)
  const loadCalendar = useStore((s) => s.loadCalendar)
  const loadCalendarConnections = useStore((s) => s.loadCalendarConnections)

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [scheduling, setScheduling] = useState(false)
  const [view, setView] = useState<ViewMode>(initialView)

  function changeView(next: ViewMode) {
    setView(next)
    localStorage.setItem(VIEW_KEY, next)
  }

  function step(direction: 1 | -1) {
    const base = selectedDate ? dayjs(selectedDate) : dayjs()
    const amount = view === 'week' ? 7 : 1
    setSelectedDate(dayKey(base.add(direction * amount, 'day')))
  }

  // Sync the URL :date into the selected day (defaults to today).
  useEffect(() => {
    setSelectedDate(date ?? dayKey(dayjs()))
  }, [date, setSelectedDate])

  useEffect(() => {
    const { from, to } = windowRange()
    setLoading(true)
    void loadCalendar(from, to).finally(() => setLoading(false))
    void loadCalendarConnections()
  }, [loadCalendar, loadCalendarConnections])

  async function refresh() {
    setRefreshing(true)
    try {
      await api.calendar.sync()
      toastInfo('Refreshing your calendars…')
      const { from, to } = windowRange()
      await loadCalendar(from, to)
      await loadCalendarConnections()
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not refresh calendars.')
    } finally {
      setRefreshing(false)
    }
  }

  const weekStart = startOfWeek(selectedDate ?? dayjs())
  const title =
    view === 'week'
      ? weekHeading(weekStart)
      : selectedDate
        ? dayHeading(selectedDate)
        : 'Calendar'
  const subtitle =
    view === 'week'
      ? ''
      : selectedDate
        ? dayjs(selectedDate).format('dddd, MMMM D, YYYY')
        : ''

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-5">
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{title}</span>
          {subtitle && (
            <span className="ml-2 hidden text-sm text-[var(--color-text-faint)] sm:inline">
              {subtitle}
            </span>
          )}
        </div>
        <div className="order-3 flex w-full items-center gap-1.5 sm:order-none sm:w-auto">
          <div className="flex items-center rounded-md border border-[var(--color-border)] p-0.5">
            {(['day', 'week'] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => changeView(mode)}
                className={`min-h-10 rounded px-3 py-1 text-sm capitalize transition sm:min-h-0 ${
                  view === mode
                    ? 'bg-[var(--color-panel)] font-medium text-[var(--color-text)]'
                    : 'text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => step(-1)}
            aria-label={view === 'week' ? 'Previous week' : 'Previous day'}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] sm:h-9 sm:w-9"
          >
            <ChevronIcon direction="left" />
          </button>
          <button
            type="button"
            onClick={() => step(1)}
            aria-label={view === 'week' ? 'Next week' : 'Next day'}
            className="flex h-11 w-11 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] sm:h-9 sm:w-9"
          >
            <ChevronIcon direction="right" />
          </button>
          <button
            type="button"
            onClick={() => setSelectedDate(dayKey(dayjs()))}
            className="min-h-11 rounded-md border border-[var(--color-border)] px-3 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] sm:min-h-9"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            aria-label="Refresh calendars"
            title="Refresh calendars"
            className="flex h-11 w-11 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] disabled:opacity-50 sm:h-9 sm:w-9"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setScheduling(true)}
          className="meeting-button-primary order-2 flex min-h-11 items-center gap-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] sm:order-none sm:min-h-9"
        >
          <PlusIcon /> New meeting
        </button>
      </header>

      {view === 'week' ? (
        <WeekGrid items={items} selectedDate={selectedDate} loading={loading} />
      ) : (
        <AgendaList items={items} selectedDate={selectedDate} loading={loading} />
      )}

      {scheduling && <ScheduleMeetingModal onClose={() => setScheduling(false)} />}
    </main>
  )
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {direction === 'left' ? <path d="m15 18-6-6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  )
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={spinning ? 'animate-spin motion-reduce:animate-none' : ''}
    >
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
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
