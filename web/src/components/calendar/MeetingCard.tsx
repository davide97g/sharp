import { useEffect, useState } from 'react'
import type { ScheduledMeeting } from '../../lib/types'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { timeRange, dayHeading, dayKey, withinJoinWindow } from '../../lib/calendar'
import { toastError } from '../../lib/toast'

const RSVP_OPTIONS: { value: string; label: string }[] = [
  { value: 'accepted', label: 'Yes' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'No' },
]

/**
 * Chat-card renderer for the `[[meet:<uuid>|<title>|<iso>]]` token. Shows the
 * token's title/time immediately, then fetches live meeting state for Join +
 * RSVP and the cancelled badge.
 */
export function MeetingCard({
  id,
  title,
  iso,
}: {
  id: string
  title: string
  iso: string
}) {
  const [meeting, setMeeting] = useState<ScheduledMeeting | null>(null)
  const [loaded, setLoaded] = useState(false)
  const joinScheduledMeeting = useStore((s) => s.joinScheduledMeeting)
  const rsvpMeeting = useStore((s) => s.rsvpMeeting)

  useEffect(() => {
    let active = true
    api.calendar.meetings
      .get(id)
      .then((m) => {
        if (active) setMeeting(m)
      })
      .catch(() => {
        /* keep token fallback */
      })
      .finally(() => {
        if (active) setLoaded(true)
      })
    return () => {
      active = false
    }
  }, [id])

  const displayTitle = meeting?.title || title || 'Meeting'
  const startIso = meeting?.start_at ?? iso
  const endIso = meeting?.end_at ?? iso
  const allDay = meeting?.all_day ?? false
  const cancelled = meeting?.status === 'cancelled'
  const canJoin =
    !!meeting &&
    !cancelled &&
    !!meeting.join_path &&
    withinJoinWindow(startIso, endIso)

  async function rsvp(response: string) {
    if (!meeting) return
    try {
      await rsvpMeeting(meeting.id, response)
      setMeeting((m) => (m ? { ...m, my_response: response } : m))
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update RSVP.')
    }
  }

  return (
    <div
      className={`my-1 max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 ${
        cancelled ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]">
          <CalendarIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-sm font-semibold text-[var(--color-text)] ${
              cancelled ? 'line-through' : ''
            }`}
          >
            {displayTitle}
          </div>
          <div className="text-xs text-[var(--color-text-faint)]">
            {startIso ? dayHeading(dayKey(startIso)) : ''}
            {startIso && ' · '}
            {timeRange(startIso, endIso, allDay)}
          </div>
          {cancelled && (
            <span className="mt-1 inline-block rounded bg-[#ff6b5f]/10 px-1.5 py-0.5 text-3xs font-semibold text-[#ff8a80]">
              Cancelled
            </span>
          )}
        </div>
      </div>

      {meeting && !cancelled && (
        <div className="mt-3 flex items-center gap-2">
          {meeting.join_path && (
            <button
              type="button"
              onClick={() => joinScheduledMeeting(meeting.join_path)}
              disabled={!canJoin}
              title={canJoin ? 'Join the call' : 'Available near the start time'}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Join
            </button>
          )}
          <div className="flex items-center gap-1">
            {RSVP_OPTIONS.map((opt) => {
              const active = meeting.my_response === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => void rsvp(opt.value)}
                  className={`rounded-md border px-2 py-1 text-2xs font-medium transition ${
                    active
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {loaded && !meeting && (
        <div className="mt-2 text-2xs text-[var(--color-text-faint)]">
          Meeting details unavailable.
        </div>
      )}
    </div>
  )
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4" />
    </svg>
  )
}
