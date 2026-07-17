import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import type { MeetingListItem } from '../../lib/types'
import { useStore } from '../../store'

export function MeetingsHome() {
  const [params] = useSearchParams()
  const channelId = params.get('channel') ?? undefined
  const activeMeetings = useStore((state) => state.activeMeetings)
  const [meetings, setMeetings] = useState<MeetingListItem[]>([])
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    setLoading(true)
    void api.meetings
      .list({ channelId, limit: 100 })
      .then((result) => setMeetings(result.meetings))
      .catch(() => setMeetings([]))
      .finally(() => setLoading(false))
  }, [channelId, activeMeetings])

  const live = meetings.filter((meeting) => meeting.status === 'active')
  const completed = meetings.filter((meeting) => meeting.status !== 'active')
  const totalMinutes = useMemo(
    () => completed.reduce((total, meeting) => total + durationMinutes(meeting), 0),
    [completed],
  )

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 items-center border-b border-[var(--color-border)] px-5">
        <span className="font-semibold">Meeting records</span>
        <span className="ml-2 text-sm text-[var(--color-text-faint)]">Attendance, notes, transcript</span>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
          <section className="mb-10 grid gap-6 border-b border-[var(--color-border)] pb-8 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="meeting-kicker">Durable call memory</p>
              <h1 className="mt-2 max-w-3xl text-3xl font-semibold tracking-[-0.035em] text-[var(--color-text)] sm:text-4xl">
                What was said, who was there, what happens next.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-dim)]">
                Notes begin when one participant opts in. Only microphones explicitly sharing a transcript contribute speech.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-px self-end overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-border)]">
              <Metric value={String(completed.length)} label="records" />
              <Metric value={formatMinutes(totalMinutes)} label="captured" />
            </div>
          </section>

          {live.length > 0 && (
            <section className="mb-9">
              <h2 className="meeting-kicker mb-3 text-[#ff8a80]">Live now</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {live.map((meeting) => (
                  <MeetingCard key={meeting.id} meeting={meeting} onOpen={() => navigate(`/meetings/${meeting.id}`)} live />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="meeting-kicker">Recent records</h2>
              <span className="text-[11px] text-[var(--color-text-faint)]">Newest first</span>
            </div>
            {loading ? (
              <div className="py-20 text-center text-sm text-[var(--color-text-faint)]">Loading meeting records…</div>
            ) : completed.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[var(--color-border)] px-6 py-16 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[#ff6b5f]/10 text-[#ff8a80]">●</div>
                <h3 className="font-medium">No completed meeting records</h3>
                <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--color-text-faint)]">
                  Join a channel call and choose “Start meeting notes.” Record ends when last participant leaves.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {completed.map((meeting) => (
                  <MeetingRow key={meeting.id} meeting={meeting} onOpen={() => navigate(`/meetings/${meeting.id}`)} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  )
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-28 bg-[var(--color-panel)] px-5 py-4">
      <div className="font-mono text-xl font-medium tabular-nums">{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--color-text-faint)]">{label}</div>
    </div>
  )
}

function MeetingCard({ meeting, onOpen, live }: { meeting: MeetingListItem; onOpen: () => void; live?: boolean }) {
  return (
    <button onClick={onOpen} className="group rounded-2xl border border-[#ff6b5f]/25 bg-[#ff6b5f]/5 p-5 text-left hover:border-[#ff6b5f]/55">
      <div className="mb-5 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#ff8a80]">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[#ff6b5f] motion-reduce:animate-none" />
          {live ? 'Recording notes' : meeting.status}
        </span>
        <span className="font-mono text-[11px] text-[var(--color-text-faint)]">{timeOf(meeting.started_at)}</span>
      </div>
      <div className="font-semibold group-hover:text-white">{meeting.title}</div>
      <div className="mt-2 text-xs text-[var(--color-text-faint)]">#{meeting.channel_name} · {meeting.participant_count} participants</div>
    </button>
  )
}

function MeetingRow({ meeting, onOpen }: { meeting: MeetingListItem; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="group grid w-full grid-cols-[5rem_1fr_auto] items-center gap-4 py-4 text-left hover:bg-[var(--color-panel)] sm:grid-cols-[7rem_1fr_auto] sm:px-3">
      <div>
        <div className="font-mono text-xs tabular-nums text-[var(--color-text-dim)]">{dayOf(meeting.started_at)}</div>
        <div className="mt-1 font-mono text-[10px] tabular-nums text-[var(--color-text-faint)]">{timeOf(meeting.started_at)}</div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium group-hover:text-white">{meeting.title}</div>
        <div className="mt-1 truncate text-xs text-[var(--color-text-faint)]">#{meeting.channel_name} · {meeting.participant_count} participants · {meeting.transcript_count} phrases</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-xs tabular-nums text-[var(--color-text-dim)]">{formatMinutes(durationMinutes(meeting))}</div>
        <div className={`mt-1 text-[10px] ${meeting.summary_status === 'ready' ? 'text-[#66c7aa]' : 'text-[var(--color-text-faint)]'}`}>
          {meeting.summary_status === 'ready' ? 'Notes ready' : meeting.summary_status}
        </div>
      </div>
    </button>
  )
}

function durationMinutes(meeting: MeetingListItem) {
  const end = meeting.ended_at ? new Date(meeting.ended_at).getTime() : Date.now()
  return Math.max(0, Math.round((end - new Date(meeting.started_at).getTime()) / 60_000))
}

function formatMinutes(value: number) {
  if (value < 60) return `${value}m`
  return `${Math.floor(value / 60)}h ${value % 60}m`
}

const dayOf = (value: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(value))
const timeOf = (value: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
