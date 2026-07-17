import { useEffect, useRef, useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { timeRange, withinJoinWindow } from '../../lib/calendar'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import { toastError } from '../../lib/toast'

const RSVP_OPTIONS: { value: string; label: string }[] = [
  { value: 'accepted', label: 'Yes' },
  { value: 'tentative', label: 'Maybe' },
  { value: 'declined', label: 'No' },
]

export function EventPill({ item }: { item: CalendarItem }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const channels = useStore((s) => s.channels)
  const joinScheduledMeeting = useStore((s) => s.joinScheduledMeeting)
  const rsvpMeeting = useStore((s) => s.rsvpMeeting)

  const isNative = item.source === 'native'
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = isNative && item.meeting.status === 'cancelled'
  const channel = isNative
    ? channels.find((c) => c.id === item.meeting.channel_id)
    : undefined
  const canJoin =
    item.source === 'native' &&
    !cancelled &&
    !!item.join_path &&
    withinJoinWindow(item.start_at, item.end_at)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function rsvp(response: string) {
    if (!isNative) return
    try {
      await rsvpMeeting(item.meeting.id, response)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not update RSVP.')
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`group flex w-full items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-2.5 py-2 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)] ${
          cancelled ? 'opacity-60' : ''
        }`}
      >
        <span
          aria-hidden
          className="h-8 w-1 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-sm font-medium text-[var(--color-text)] ${
              cancelled ? 'line-through' : ''
            }`}
          >
            {item.title || 'Untitled'}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]">
            <span className="tabular-nums">
              {timeRange(item.start_at, item.end_at, item.all_day)}
            </span>
            {channel && (
              <span className="truncate rounded bg-[var(--color-panel-2)] px-1 text-[10px] text-[var(--color-text-dim)]">
                {channelLabel(channel)}
              </span>
            )}
            {isNative && !channel && item.meeting.standalone_call_id && (
              <span className="rounded bg-[var(--color-panel-2)] px-1 text-[10px] text-[var(--color-text-dim)]">
                call
              </span>
            )}
          </span>
        </span>
        {canJoin && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              joinScheduledMeeting(item.source === 'native' ? item.join_path : null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                joinScheduledMeeting(item.source === 'native' ? item.join_path : null)
              }
            }}
            className="shrink-0 rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-semibold text-white hover:bg-[var(--color-accent-hover)]"
          >
            Join
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 shadow-2xl">
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
        </div>
      )}
    </div>
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
