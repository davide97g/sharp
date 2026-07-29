import { effectiveNicknames } from '../../lib/displayName'
import { useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { timeRange } from '../../lib/calendar'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import { EventDetail } from './EventDetail'
import { Popover } from '../../ui'

export function EventPill({ item }: { item: CalendarItem }) {
  const [open, setOpen] = useState(false)
  const channels = useStore((s) => s.channels)
  const nicknames = useStore(effectiveNicknames)
  const joinScheduledMeeting = useStore((s) => s.joinScheduledMeeting)

  const isNative = item.source === 'native'
  const color = item.source === 'google' ? item.color : null
  const accent = color ?? 'var(--color-accent)'
  const cancelled = isNative && item.meeting.status === 'cancelled'
  const channel = isNative
    ? channels.find((c) => c.id === item.meeting.channel_id)
    : undefined
  // Joinable any time (even early or late) as long as it isn't cancelled.
  const canJoin = item.source === 'native' && !cancelled && !!item.join_path

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      width="w-72"
      trigger={
        <div
        className={`group flex min-h-11 w-full items-stretch rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)] ${
          cancelled ? 'opacity-60' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
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
            <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-[var(--color-text-faint)]">
              <span className="tabular-nums">
                {timeRange(item.start_at, item.end_at, item.all_day)}
              </span>
              {channel && (
                <span className="truncate rounded bg-[var(--color-panel-2)] px-1 text-3xs text-[var(--color-text-dim)]">
                  {channelLabel(channel, nicknames)}
                </span>
              )}
              {isNative && !channel && item.meeting.standalone_call_id && (
                <span className="rounded bg-[var(--color-panel-2)] px-1 text-3xs text-[var(--color-text-dim)]">
                  call
                </span>
              )}
            </span>
          </span>
        </button>
        {canJoin && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              joinScheduledMeeting(item.source === 'native' ? item.join_path : null)
            }}
            className="m-1 min-h-11 shrink-0 rounded-md bg-[var(--color-accent)] px-3 text-2xs font-semibold text-white hover:bg-[var(--color-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-hover)]"
          >
            Join
          </button>
        )}
        </div>
      }
    >
      <div className="p-2">
        <EventDetail item={item} />
      </div>
    </Popover>
  )
}
