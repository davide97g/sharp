import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { toastError, toastSuccess } from '../../lib/toast'
import type { MeetingAction, MeetingAttendance, MeetingDetail, MeetingTranscriptPhrase } from '../../lib/types'
import { meetingChannelLabel, meetingDisplayTitle } from '../../lib/meetingLabels'
import { useStore } from '../../store'
import { Avatar } from '../Avatar'
import { Markdown } from '../Markdown'
import { Button, Spinner, Textarea } from '../../ui'

// TODO(ds): .meeting-kicker / .meeting-label kept as-is — their 0.12–0.14em
// tracking + 650 weight have no parity with ui SectionLabel (tracking-wider).
// TODO(ds): local EmptyText kept — its padding-less text-sm has no parity with
// EmptyState variant="inline" (px-2 py-1.5 text-xs).

type TimelineItem =
  | { kind: 'phrase'; at: string; phrase: MeetingTranscriptPhrase }
  | { kind: 'join' | 'leave'; at: string; attendance: MeetingAttendance }

const SPEAKER_COLORS = ['#7c6cff', '#ff6b5f', '#66c7aa', '#e5b95c', '#5eb4e6', '#c97adf', '#9bc45b', '#e88a4b']

export function MeetingDetailView() {
  const { meetingId } = useParams()
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const navigate = useNavigate()
  const channels = useStore((s) => s.channels)

  const load = async (quiet = false) => {
    if (!meetingId) return
    if (!quiet) setLoading(true)
    try {
      setMeeting(await api.meetings.get(meetingId))
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not load meeting.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId])

  useEffect(() => {
    if (!meeting || (meeting.status !== 'active' && meeting.summary_status !== 'pending')) return
    const timer = window.setInterval(() => void load(true), 4000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting?.status, meeting?.summary_status, meetingId])

  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ meeting_id?: string }>).detail
      if (detail?.meeting_id === meetingId) void load(true)
    }
    window.addEventListener('sharp:meeting-updated', refresh)
    return () => window.removeEventListener('sharp:meeting-updated', refresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId])

  if (loading) return <PageMessage>Loading meeting record…</PageMessage>
  if (!meeting) return <PageMessage>Meeting record unavailable.</PageMessage>

  const saveFields = async (input: { title?: string; summary?: string; decisions?: string }) => {
    try {
      const updated = await api.meetings.update(meeting.id, input)
      setMeeting(updated)
      toastSuccess('Meeting notes saved.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not save meeting notes.')
    }
  }

  const remove = async () => {
    if (!window.confirm('Permanently delete this meeting record, transcript, attendance, and notes? This cannot be undone.')) return
    try {
      await api.meetings.delete(meeting.id)
      navigate('/meetings', { replace: true })
      toastSuccess('Meeting record deleted.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not delete meeting.')
    }
  }

  const regenerate = async () => {
    if ((meeting.summary || meeting.actions.length > 0) && !window.confirm('Regenerate notes and replace the current summary, decisions, and action items?')) return
    try {
      await api.meetings.regenerate(meeting.id)
      setMeeting({ ...meeting, summary_status: 'pending' })
      toastSuccess('Notes regeneration started.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not regenerate notes.')
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-5 sm:py-0">
        <button onClick={() => navigate('/meetings')} className="min-h-11 rounded-lg px-2 text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]">‹ Meetings</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{meetingDisplayTitle(meeting, channels)}</div>
          <div className="truncate text-3xs text-[var(--color-text-faint)]">
            {meetingChannelLabel(meeting, channels)}
          </div>
        </div>
        <StatusChip meeting={meeting} />
        <button onClick={() => void regenerate()} disabled={meeting.status === 'active'} className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 text-xs text-[var(--color-text-dim)] hover:border-[var(--color-accent)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40 max-sm:order-3 max-sm:ml-auto">Regenerate</button>
        <button onClick={() => void remove()} disabled={meeting.status === 'active'} className="min-h-11 rounded-lg px-3 text-xs text-[var(--color-text-faint)] hover:bg-danger-soft hover:text-danger-fg disabled:cursor-not-allowed disabled:opacity-40 max-sm:order-3">Delete</button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-7 lg:py-10">
          <MeetingHeader
            meeting={meeting}
            displayTitle={meetingDisplayTitle(meeting, channels)}
            onSave={(title) => void saveFields({ title })}
          />

          <div className="mt-9 grid gap-8 xl:grid-cols-[minmax(0,1fr)_23rem]">
            <div className="min-w-0 space-y-8">
              <EditableNotes meeting={meeting} onSave={(input) => void saveFields(input)} />
              <ActionEditor meeting={meeting} onChange={setMeeting} />
              <TranscriptTimeline meeting={meeting} />
            </div>
            <aside className="space-y-6 xl:sticky xl:top-6 xl:self-start">
              <AttendancePanel meeting={meeting} />
              <ConsentPanel />
            </aside>
          </div>
        </div>
      </div>
    </main>
  )
}

function MeetingHeader({ meeting, displayTitle, onSave }: { meeting: MeetingDetail; displayTitle: string; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(displayTitle)
  useEffect(() => setTitle(displayTitle), [displayTitle])
  const duration = meeting.ended_at
    ? Math.max(0, new Date(meeting.ended_at).getTime() - new Date(meeting.started_at).getTime())
    : Math.max(0, Date.now() - new Date(meeting.started_at).getTime())
  return (
    <section className="border-b border-[var(--color-border)] pb-8">
      <p className="meeting-kicker">{fullDate(meeting.started_at)} · {timeOf(meeting.started_at)}</p>
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => title.trim() && title.trim() !== displayTitle && onSave(title.trim())}
        aria-label="Meeting title"
        className="mt-3 w-full bg-transparent text-3xl font-semibold tracking-[-0.04em] outline-none placeholder:text-[var(--color-text-faint)] sm:text-4xl"
      />
      <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 font-mono text-2xs tabular-nums text-[var(--color-text-faint)]">
        <span>{formatDuration(duration)}</span>
        <span>{meeting.participant_count} participants</span>
        <span>{meeting.transcript_count} transcript phrases</span>
        <span>{meeting.status === 'active' ? 'In progress' : `Ended ${meeting.ended_at ? timeOf(meeting.ended_at) : 'unexpectedly'}`}</span>
      </div>
    </section>
  )
}

function EditableNotes({ meeting, onSave }: { meeting: MeetingDetail; onSave: (input: { summary?: string; decisions?: string }) => void }) {
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState(meeting.summary)
  const [decisions, setDecisions] = useState(meeting.decisions)
  useEffect(() => { setSummary(meeting.summary); setDecisions(meeting.decisions) }, [meeting.summary, meeting.decisions])
  const pending = meeting.summary_status === 'pending'
  return (
    <section>
      <SectionHeading label="Notes" action={editing ? undefined : <button onClick={() => setEditing(true)}>Edit</button>} />
      {pending && !meeting.summary ? (
        <div className="meeting-surface flex items-center gap-3 text-sm text-[var(--color-text-dim)]">{meeting.status === 'active' ? <span className="h-2 w-2 rounded-full bg-[#ff6b5f]" /> : <Spinner size="sm" />} {meeting.status === 'active' ? 'Summary and action items will generate when the call ends.' : 'Generating summary and action items…'}</div>
      ) : editing ? (
        <div className="meeting-surface space-y-5">
          <label className="block"><span className="meeting-label">Summary</span><Textarea value={summary} onChange={(event) => setSummary(event.target.value)} rows={8} className="mt-[0.55rem]" /></label>
          <label className="block"><span className="meeting-label">Decisions · one per line</span><Textarea value={decisions} onChange={(event) => setDecisions(event.target.value)} rows={5} className="mt-[0.55rem]" /></label>
          <div className="flex justify-end gap-2"><Button variant="outline" size="sm" onClick={() => { setEditing(false); setSummary(meeting.summary); setDecisions(meeting.decisions) }}>Cancel</Button><Button size="sm" onClick={() => { onSave({ summary, decisions }); setEditing(false) }}>Save notes</Button></div>
        </div>
      ) : (
        <div className="meeting-surface space-y-6">
          <div>{meeting.summary ? <Markdown content={meeting.summary} /> : <EmptyText text={meeting.summary_status === 'failed' ? 'Summary generation failed. Regenerate to try again.' : 'No summary available.'} />}</div>
          <div><h3 className="meeting-label">Decisions</h3>{meeting.decisions ? <ul className="mt-3 space-y-2">{meeting.decisions.split('\n').filter(Boolean).map((decision, index) => <li key={index} className="flex gap-3 text-sm leading-6 text-[var(--color-text-dim)]"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />{decision}</li>)}</ul> : <EmptyText text="No decisions captured." />}</div>
        </div>
      )}
    </section>
  )
}

function ActionEditor({ meeting, onChange }: { meeting: MeetingDetail; onChange: (meeting: MeetingDetail) => void }) {
  const [actions, setActions] = useState(meeting.actions)
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setActions(meeting.actions) }, [meeting.actions, dirty])
  const attendees = uniqueMemberAttendees(meeting.attendance)
  const update = (index: number, patch: Partial<MeetingAction>) => {
    setActions(actions.map((action, actionIndex) => actionIndex === index ? { ...action, ...patch } : action))
    setDirty(true)
  }
  const save = async () => {
    try {
      const updated = await api.meetings.saveActions(meeting.id, actions.map(({ id, text, assignee_user_id, completed }) => ({ id, text, assignee_user_id, completed })))
      onChange(updated); setActions(updated.actions); setDirty(false); toastSuccess('Action items saved.')
    } catch (error) { toastError(error instanceof Error ? error.message : 'Could not save action items.') }
  }
  return (
    <section>
      <SectionHeading label="Action items" action={<button onClick={() => { setActions([...actions, { id: crypto.randomUUID(), text: '', assignee_user_id: null, assignee_name: null, completed: false, position: actions.length }]); setDirty(true) }}>Add item</button>} />
      <div className="meeting-surface p-0">
        {actions.length === 0 ? <div className="px-5 py-8"><EmptyText text="No action items captured." /></div> : actions.map((action, index) => (
          <div key={action.id} className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-[var(--color-border)] px-4 py-3 last:border-0 sm:grid-cols-[auto_1fr_auto]">
            <input type="checkbox" checked={action.completed} onChange={(event) => update(index, { completed: event.target.checked })} className="h-4 w-4 accent-[var(--color-accent)]" aria-label={`Complete ${action.text || 'action item'}`} />
            <input value={action.text} onChange={(event) => update(index, { text: event.target.value })} placeholder="Describe next step" className={`min-w-0 bg-transparent text-sm outline-none ${action.completed ? 'text-[var(--color-text-faint)] line-through' : ''}`} />
            <div className="col-span-2 flex items-center justify-end gap-2 sm:col-span-1">
              <select value={action.assignee_user_id ?? ''} onChange={(event) => update(index, { assignee_user_id: event.target.value || null })} className="max-w-32 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-2xs text-[var(--color-text-dim)] outline-none">
                <option value="">Unassigned</option>{attendees.map((attendee) => <option key={attendee.user_id!} value={attendee.user_id!}>{attendee.display_name}</option>)}
              </select>
              <button onClick={() => { setActions(actions.filter((_, actionIndex) => actionIndex !== index)); setDirty(true) }} className="text-[var(--color-text-faint)] hover:text-danger-fg" aria-label="Remove action">×</button>
            </div>
          </div>
        ))}
        {dirty && <div className="flex justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3"><Button variant="outline" size="sm" onClick={() => { setActions(meeting.actions); setDirty(false) }}>Discard</Button><Button size="sm" onClick={() => void save()} disabled={actions.some((action) => !action.text.trim())}>Save actions</Button></div>}
      </div>
    </section>
  )
}

function TranscriptTimeline({ meeting }: { meeting: MeetingDetail }) {
  const [query, setQuery] = useState('')
  const timeline = useMemo(() => {
    const items: TimelineItem[] = meeting.transcript.map((phrase) => ({ kind: 'phrase', at: phrase.spoken_at, phrase }))
    for (const attendance of meeting.attendance) {
      items.push({ kind: 'join', at: attendance.joined_at, attendance })
      if (attendance.left_at) items.push({ kind: 'leave', at: attendance.left_at, attendance })
    }
    return items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  }, [meeting.attendance, meeting.transcript])
  const visible = timeline.filter((item) => item.kind !== 'phrase' || !query || item.phrase.text.toLowerCase().includes(query.toLowerCase()) || item.phrase.display_name.toLowerCase().includes(query.toLowerCase()))
  return (
    <section>
      <SectionHeading label="Time record" action={<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcript" className="w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)]" />} />
      <div className="meeting-surface p-0">
        {visible.length === 0 ? <div className="px-5 py-10"><EmptyText text="No transcript phrases match." /></div> : visible.map((item, index) => <TimelineRow key={`${item.kind}-${item.kind === 'phrase' ? item.phrase.id : item.attendance.id}-${index}`} item={item} startedAt={meeting.started_at} />)}
      </div>
    </section>
  )
}

function TimelineRow({ item, startedAt }: { item: TimelineItem; startedAt: string }) {
  if (item.kind !== 'phrase') return (
    <div className="grid grid-cols-[4.25rem_1rem_1fr] gap-3 px-4 py-2 text-2xs text-[var(--color-text-faint)]">
      <time className="font-mono tabular-nums">{offsetTime(startedAt, item.at)}</time><span className="mt-1 h-2 w-2 rounded-full border border-[var(--color-text-faint)]" /><span>{item.attendance.display_name} {item.kind === 'join' ? 'joined' : 'left'}</span>
    </div>
  )
  const color = speakerColor(item.phrase.user_id ?? item.phrase.display_name)
  return (
    <div className="group grid grid-cols-[4.25rem_1rem_1fr] gap-3 border-t border-[var(--color-border-soft)] px-4 py-4 first:border-0">
      <time className="font-mono text-3xs tabular-nums text-[var(--color-text-faint)]">{offsetTime(startedAt, item.at)}</time>
      <span className="relative"><span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 opacity-30" style={{ backgroundColor: color }} /><span className="relative block h-2.5 w-2.5 rounded-full ring-4 ring-[var(--color-panel)]" style={{ backgroundColor: color }} /></span>
      <div className="min-w-0"><div className="mb-1 flex items-center gap-2"><span className="text-xs font-semibold" style={{ color }}>{item.phrase.display_name}</span>{item.phrase.guest && <span className="rounded border border-[var(--color-border)] px-1 text-[9px] text-[var(--color-text-faint)]">guest</span>}<time className="font-mono text-[9px] text-[var(--color-text-faint)]">{timeOf(item.at)}</time></div><p className="text-sm leading-6 text-[var(--color-text-dim)]">{item.phrase.text}</p></div>
    </div>
  )
}

function AttendancePanel({ meeting }: { meeting: MeetingDetail }) {
  const attendees = uniqueAttendees(meeting.attendance)
  return (
    <section className="meeting-surface">
      <h2 className="meeting-label">Attendance</h2>
      <div className="mt-4 space-y-4">{attendees.map((attendee) => (
        <div key={attendee.key} className="flex items-center gap-3"><Avatar id={attendee.user_id ?? attendee.key} name={attendee.display_name} size={30} /><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium">{attendee.display_name}{attendee.guest ? ' · guest' : ''}</div><div className="mt-0.5 font-mono text-[9px] tabular-nums text-[var(--color-text-faint)]">{timeOf(attendee.joined_at)}–{attendee.left_at ? timeOf(attendee.left_at) : 'present'}</div></div><span className="h-2 w-2 rounded-full" style={{ backgroundColor: speakerColor(attendee.user_id ?? attendee.key) }} /></div>
      ))}</div>
    </section>
  )
}

function ConsentPanel() { return <section className="rounded-xl border border-[#ff6b5f]/20 bg-[#ff6b5f]/5 p-4"><h2 className="meeting-label text-[#ff8a80]">Consent boundary</h2><p className="mt-3 text-xs leading-5 text-[var(--color-text-faint)]">Attendance covers everyone present after notes began. Transcript contains only speech from participants who explicitly shared their microphone transcript. AI notes may be processed by configured AI provider.</p></section> }
function StatusChip({ meeting }: { meeting: MeetingDetail }) { return <span className={`rounded-full border px-2.5 py-1 text-3xs font-semibold ${meeting.status === 'active' ? 'border-[#ff6b5f]/35 bg-[#ff6b5f]/10 text-[#ff8a80]' : meeting.status === 'interrupted' ? 'border-warning-fg/25 bg-warning-soft text-warning-fg' : 'border-[var(--color-border)] text-[var(--color-text-faint)]'}`}>{meeting.status === 'active' ? '● Live' : meeting.status}</span> }
function SectionHeading({ label, action }: { label: string; action?: React.ReactNode }) { return <div className="mb-3 flex min-h-8 items-center justify-between"><h2 className="meeting-kicker">{label}</h2><div className="text-xs text-[var(--color-accent-hover)] [&_button:hover]:underline">{action}</div></div> }
function EmptyText({ text }: { text: string }) { return <p className="text-sm text-[var(--color-text-faint)]">{text}</p> }
function PageMessage({ children }: { children: React.ReactNode }) { return <main className="flex flex-1 items-center justify-center bg-[var(--color-ink)] text-sm text-[var(--color-text-faint)]">{children}</main> }
function uniqueMemberAttendees(attendance: MeetingAttendance[]) { const seen = new Set<string>(); return attendance.filter((item) => item.user_id && !seen.has(item.user_id) && Boolean(seen.add(item.user_id))) }
function uniqueAttendees(attendance: MeetingAttendance[]) { const map = new Map<string, MeetingAttendance & { key: string }>(); for (const item of attendance) { const key = item.user_id ?? `${item.display_name}-${item.guest}`; const existing = map.get(key); if (!existing) map.set(key, { ...item, key }); else { if (new Date(item.joined_at) < new Date(existing.joined_at)) existing.joined_at = item.joined_at; if (!existing.left_at || !item.left_at) existing.left_at = null; else if (new Date(item.left_at) > new Date(existing.left_at)) existing.left_at = item.left_at } } return [...map.values()] }
function speakerColor(key: string) { let hash = 0; for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) | 0; return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length] }
function offsetTime(start: string, at: string) { const seconds = Math.max(0, Math.floor((new Date(at).getTime() - new Date(start).getTime()) / 1000)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` }
function formatDuration(ms: number) { const minutes = Math.floor(ms / 60_000); return `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)}h ` : ''}${minutes % 60}m` }
const fullDate = (value: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(value))
const timeOf = (value: string) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
