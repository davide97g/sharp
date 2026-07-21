import { useEffect, useMemo, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { channelLabel } from '../../lib/util'
import { meetingChannelLabel, meetingDisplayTitle } from '../../lib/meetingLabels'
import type { MeetingListItem } from '../../lib/types'
import { useStore } from '../../store'

export function MeetingsSidebar() {
  const channels = useStore((state) => state.channels)
  const nicknames = useStore((state) => state.nicknames)
  const activeMeetings = useStore((state) => state.activeMeetings)
  const [meetings, setMeetings] = useState<MeetingListItem[]>([])
  const [search, setSearch] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api.meetings
        .list({ q: search.trim(), limit: 50 })
        .then((result) => setMeetings(result.meetings))
        .catch(() => setMeetings([]))
    }, search ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [search, activeMeetings])

  const groups = useMemo(() => groupMeetings(meetings), [meetings])

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#ff6b5f]/10 text-[#ff8a80] ring-1 ring-[#ff6b5f]/25">
          <MeetingIcon />
        </span>
        <span className="font-bold tracking-tight">Meetings</span>
      </div>

      <div className="space-y-2 px-3 pt-3">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search meeting records…"
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
        />
        <NavLink
          to="/meetings"
          end
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
              isActive
                ? 'bg-[var(--color-accent-soft)] text-white'
                : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
            }`
          }
        >
          <span className="text-[var(--color-text-faint)]">⌂</span> All meetings
        </NavLink>
        <select
          aria-label="Filter by channel"
          value=""
          onChange={(event) => {
            if (event.target.value) navigate(`/meetings?channel=${event.target.value}`)
          }}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-xs text-[var(--color-text-dim)] outline-none focus:border-[var(--color-accent)]"
        >
          <option value="">Filter by channel…</option>
          {channels.filter((channel) => channel.is_member).map((channel) => (
            <option key={channel.id} value={channel.id}>{channelLabel(channel, nicknames)}</option>
          ))}
        </select>
      </div>

      <nav aria-label="Meeting records" className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {meetings.length === 0 && (
          <p className="px-2 py-6 text-center text-xs leading-5 text-[var(--color-text-faint)]">
            {search ? 'No meeting records match.' : 'Meeting records appear when someone starts notes in a call.'}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="mb-4">
            <h2 className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-faint)]">
              {group.label}
            </h2>
            <div className="space-y-0.5">
              {group.items.map((meeting) => (
                <NavLink
                  key={meeting.id}
                  to={`/meetings/${meeting.id}`}
                  className={({ isActive }) =>
                    `block rounded-lg px-2.5 py-2 ${
                      isActive
                        ? 'bg-[var(--color-accent-soft)] text-white'
                        : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
                    }`
                  }
                >
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meeting.status === 'active' ? 'bg-[#ff6b5f]' : 'bg-[var(--color-text-faint)]'}`} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{meetingDisplayTitle(meeting, channels)}</span>
                  </div>
                  <div className="mt-1 truncate pl-3.5 text-[10px] text-[var(--color-text-faint)]">
                    {meetingChannelLabel(meeting, channels)}
                    {' · '}{shortTime(meeting.started_at)}
                  </div>
                </NavLink>
              ))}
            </div>
          </section>
        ))}
      </nav>

      {Object.keys(activeMeetings).length > 0 && (
        <div className="border-t border-[#ff6b5f]/20 bg-[#ff6b5f]/5 px-4 py-3 text-[11px] text-[#ff8a80]">
          <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[#ff6b5f]" />
          {Object.keys(activeMeetings).length} live meeting {Object.keys(activeMeetings).length === 1 ? 'record' : 'records'}
        </div>
      )}
    </aside>
  )
}

function groupMeetings(meetings: MeetingListItem[]) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const week = new Date(today)
  week.setDate(week.getDate() - 7)
  const groups = [
    { label: 'Today', items: [] as MeetingListItem[] },
    { label: 'This week', items: [] as MeetingListItem[] },
    { label: 'Older', items: [] as MeetingListItem[] },
  ]
  for (const meeting of meetings) {
    const date = new Date(meeting.started_at)
    if (date >= today) groups[0].items.push(meeting)
    else if (date >= week) groups[1].items.push(meeting)
    else groups[2].items.push(meeting)
  }
  return groups.filter((group) => group.items.length > 0)
}

function shortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

export function MeetingIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  )
}
