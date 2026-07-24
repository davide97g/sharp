import { useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { timeRange } from '../../lib/calendar'
import { useStore } from '../../store'
import { toastError, toastSuccess } from '../../lib/toast'
import { ScheduleMeetingModal } from './ScheduleMeetingModal'
import { Markdown } from '../Markdown'
import { SectionLabel } from '../../ui'

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
  const deleteScheduledMeeting = useStore((s) => s.deleteScheduledMeeting)
  const me = useStore((s) => s.me)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const isNative = item.source === 'native'
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = isNative && item.meeting.status === 'cancelled'
  const canEdit = isNative && !cancelled && me?.id === item.meeting.creator.id
  // Sharp-generated meetings expose an in-app meet link (like Google Meet).
  // Google-imported events do not — their content stays read-only.
  const meetUrl =
    isNative && item.join_path && !cancelled
      ? window.location.origin + item.join_path
      : null

  async function rsvp(response: string) {
    if (!isNative) return
    try {
      await rsvpMeeting(item.meeting.id, response)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update RSVP.')
    }
  }

  async function copyLink() {
    if (!meetUrl) return
    try {
      await navigator.clipboard.writeText(meetUrl)
      toastSuccess('Invite link copied.')
    } catch {
      toastError('Could not copy the link.')
    }
  }

  async function remove() {
    if (!isNative || deleting) return
    if (!window.confirm(`Delete "${item.title || 'this meeting'}"? This can't be undone.`)) return
    setDeleting(true)
    try {
      await deleteScheduledMeeting(item.meeting.id)
      toastSuccess('Meeting deleted.')
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not delete the meeting.')
      setDeleting(false)
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
          <div className="text-2xs text-[var(--color-text-faint)]">
            {timeRange(item.start_at, item.end_at, item.all_day)}
          </div>
        </div>
      </div>

      {cancelled && (
        <div className="mb-2 rounded-md bg-[#ff6b5f]/10 px-2 py-1 text-2xs font-medium text-[#ff8a80]">
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
        <div className="mb-2 max-h-32 overflow-y-auto text-xs leading-5 text-[var(--color-text-dim)] [&_a]:break-all [&_a]:text-[var(--color-accent-hover)] [&_a:hover]:underline">
          <Markdown
            content={
              (item.source === 'google' ? item.description : item.meeting.description) ?? ''
            }
          />
        </div>
      )}

      {isNative && item.meeting.attendees.length > 0 && (
        <div className="mb-2">
          <SectionLabel size="3xs" className="mb-1">
            Attendees
          </SectionLabel>
          <ul className="space-y-0.5">
            {item.meeting.attendees.map((a) => (
              <li
                key={a.user_id}
                className="flex items-center justify-between gap-2 text-xs text-[var(--color-text-dim)]"
              >
                <span className="truncate">{a.display_name}</span>
                <span className="shrink-0 text-3xs text-[var(--color-text-faint)]">
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
                className={`flex-1 rounded-md border px-2 py-1 text-2xs font-medium transition ${
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

      {meetUrl && (
        <button
          type="button"
          onClick={() => void copyLink()}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          <LinkIcon />
          Copy invite link
        </button>
      )}

      {canEdit && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={deleting}
            className="flex-1 rounded-md border border-[var(--color-border)] px-2 py-1.5 text-xs font-medium text-[var(--color-text-dim)] hover:bg-danger-soft hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
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

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
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
