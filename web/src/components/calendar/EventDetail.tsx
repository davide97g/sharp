import { useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { timeRange } from '../../lib/calendar'
import { useStore } from '../../store'
import { toastError } from '../../lib/toast'
import { ScheduleMeetingModal } from './ScheduleMeetingModal'

const RSVP_OPTIONS: { value: string; label: string }[] = [
  { value: 'accepted', label: 'Yes' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'No' },
]

/**
 * Shared expanded card for a calendar item — description, attendees, RSVP,
 * join, Google link, and (for the meeting's creator) an Edit button. Rendered
 * inside both the agenda EventPill popover and the week-grid popover.
 */
export function EventDetail({ item }: { item: CalendarItem }) {
  const joinScheduledMeeting = useStore((s) => s.joinScheduledMeeting)
  const rsvpMeeting = useStore((s) => s.rsvpMeeting)
  const me = useStore((s) => s.me)
  const [editing, setEditing] = useState(false)

  const isNative = item.source === 'native'
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = isNative && item.meeting.status === 'cancelled'
  const canEdit = isNative && !cancelled && me?.id === item.meeting.creator.id

  async function rsvp(response: string) {
    if (!isNative) return
    try {
      await rsvpMeeting(item.meeting.id, response)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update RSVP.')
    }
  }

  return (
    <>
      <div className="mb-1 flex items-start gap-2">
        <span
          aria-hidden
          className="mt-1 h-3 w-3 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-[var(--color-text)]">
            {item.title || 'Untitled'}
          </div>
          <div className="text-[11px] text-[var(--color-text-faint)]">
            {timeRange(item.start_at, item.end_at, item.all_day)}
          </div>
        </div>
      </div>

      {cancelled && (
        <div className="mb-2 rounded-md bg-[#ff6b5f]/10 px-2 py-1 text-[11px] font-medium text-[#ff8a80]">
          Cancelled
        </div>
      )}

      {item.source === 'google' && item.location && (
        <div className="mb-1 text-xs text-[var(--color-text-dim)]">
          📍 {item.location}
        </div>
      )}

      {((item.source === 'google' && item.description) ||
        (isNative && item.meeting.description)) && (
        <p className="mb-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-[var(--color-text-dim)]">
          {item.source === 'google' ? item.description : item.meeting.description}
        </p>
      )}

      {isNative && item.meeting.attendees.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Attendees
          </div>
          <ul className="space-y-0.5">
            {item.meeting.attendees.map((a) => (
              <li
                key={a.user_id}
                className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-dim)]"
              >
                <span className="truncate">{a.display_name}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">
                  {rsvpLabel(a.response)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isNative && !cancelled && (
        <div className="flex items-center gap-1.5">
          {RSVP_OPTIONS.map((opt) => {
            const active = item.meeting.my_response === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => void rsvp(opt.value)}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] font-medium transition ${
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
      )}

      {isNative && item.join_path && !cancelled && (
        <button
          type="button"
          onClick={() => joinScheduledMeeting(item.join_path)}
          className="mt-2 w-full rounded-md bg-[var(--color-accent)] px-2 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]"
        >
          Join call
        </button>
      )}

      {canEdit && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 w-full rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          Edit
        </button>
      )}

      {item.source === 'google' && item.html_link && (
        <a
          href={item.html_link}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-1 block rounded-md border border-[var(--color-border)] px-2 py-1.5 text-center text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
        >
          Open in Google Calendar
        </a>
      )}

      {editing && isNative && (
        <ScheduleMeetingModal
          meeting={item.meeting}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  )
}

function rsvpLabel(response: string): string {
  switch (response) {
    case 'accepted':
      return 'Going'
    case 'declined':
      return 'No'
    case 'tentative':
      return 'Maybe'
    default:
      return '—'
  }
}
