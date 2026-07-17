import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import { toastError, toastInfo } from '../../lib/toast'
import { dayjs, dayKey, dayHeading } from '../../lib/calendar'
import { AgendaList } from './AgendaList'
import { ScheduleMeetingModal } from './ScheduleMeetingModal'

// Rolling window that mirrors the server's sync range (-30d / +90d).
function windowRange() {
  return {
    from: dayjs().subtract(30, 'day').startOf('day').toISOString(),
    to: dayjs().add(90, 'day').endOf('day').toISOString(),
  }
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

  const title = selectedDate ? dayHeading(selectedDate) : 'Calendar'
  const subtitle = selectedDate ? dayjs(selectedDate).format('dddd, MMMM D, YYYY') : ''

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex min-h-14 items-center gap-3 border-b border-[var(--color-border)] px-5 py-2">
        <div className="min-w-0 flex-1">
          <span className="font-semibold">{title}</span>
          {subtitle && (
            <span className="ml-2 hidden text-sm text-[var(--color-text-faint)] sm:inline">
              {subtitle}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setSelectedDate(dayKey(dayjs()))}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        >
          Today
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh calendars"
          title="Refresh calendars"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          <RefreshIcon spinning={refreshing} />
        </button>
        <button
          type="button"
          onClick={() => setScheduling(true)}
          className="meeting-button-primary flex h-9 items-center gap-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        >
          <PlusIcon /> New meeting
        </button>
      </header>

      <AgendaList items={items} selectedDate={selectedDate} loading={loading} />

      {scheduling && <ScheduleMeetingModal onClose={() => setScheduling(false)} />}
    </main>
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
