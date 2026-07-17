import { useEffect, useRef, useState } from 'react'
import type { CalendarItem } from '../../lib/types'
import { timeRange, withinJoinWindow } from '../../lib/calendar'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import { EventDetail } from './EventDetail'

export function EventPill({ item }: { item: CalendarItem }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const channels = useStore((s) => s.channels)
  const joinScheduledMeeting = useStore((s) => s.joinScheduledMeeting)

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
          <EventDetail item={item} />
        </div>
      )}
    </div>
  )
}
