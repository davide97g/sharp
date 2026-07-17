import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { toastError, toastSuccess } from '../../lib/toast'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import {
  dayjs,
  nextHalfHourIso,
  isoToDatetimeLocal,
  datetimeLocalToIso,
  startOfDayIso,
  endOfDayIso,
} from '../../lib/calendar'

const DURATIONS = [15, 30, 45, 60, 90, 120]

type Context = string // 'channel:<id>' | 'standalone' | 'none'

/**
 * Hand-rolled modal (cloned from NewMeetDialog) for scheduling a native meeting.
 * `channelId` prefills the channel context and defaults attendees to its members.
 */
export function ScheduleMeetingModal({
  onClose,
  channelId,
}: {
  onClose: () => void
  channelId?: string | null
}) {
  const channels = useStore((s) => s.channels)
  const users = useStore((s) => s.users)
  const membersByChannel = useStore((s) => s.members)
  const loadMembers = useStore((s) => s.loadMembers)
  const createScheduledMeeting = useStore((s) => s.createScheduledMeeting)

  const prefillChannel = channelId
    ? channels.find((c) => c.id === channelId)
    : undefined

  const [title, setTitle] = useState(
    prefillChannel ? `Meeting in ${channelLabel(prefillChannel)}` : 'Meeting',
  )
  const [startLocal, setStartLocal] = useState(() =>
    isoToDatetimeLocal(nextHalfHourIso()),
  )
  const [durationMin, setDurationMin] = useState(30)
  const [allDay, setAllDay] = useState(false)
  const [context, setContext] = useState<Context>(
    channelId ? `channel:${channelId}` : 'none',
  )
  const [description, setDescription] = useState('')
  const [postCard, setPostCard] = useState(!!channelId)
  const [attendees, setAttendees] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  const contextChannelId = context.startsWith('channel:')
    ? context.slice('channel:'.length)
    : null

  // Load + default attendees to the selected channel's members.
  useEffect(() => {
    if (!contextChannelId) return
    void loadMembers(contextChannelId)
  }, [contextChannelId, loadMembers])

  useEffect(() => {
    if (!contextChannelId) return
    const members = membersByChannel[contextChannelId]
    if (members) setAttendees(new Set(members.map((m) => m.id)))
  }, [contextChannelId, membersByChannel])

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    inputRef.current?.select()
    return () => previousFocus?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      )
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  // Candidate attendees = workspace directory, self first, then by name.
  const directory = useMemo(
    () =>
      Object.values(users).sort((a, b) =>
        a.display_name.localeCompare(b.display_name),
      ),
    [users],
  )

  function toggleAttendee(id: string) {
    setAttendees((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      let startIso: string
      let endIso: string
      if (allDay) {
        startIso = startOfDayIso(datetimeLocalToIso(startLocal))
        endIso = endOfDayIso(datetimeLocalToIso(startLocal))
      } else {
        startIso = datetimeLocalToIso(startLocal)
        endIso = dayjs(startIso).add(durationMin, 'minute').toISOString()
      }

      let payloadChannelId: string | null = null
      let standaloneCallId: string | null = null
      if (contextChannelId) {
        payloadChannelId = contextChannelId
      } else if (context === 'standalone') {
        const call = await api.calls.create(value)
        standaloneCallId = call.room_id
      }

      await createScheduledMeeting({
        title: value,
        description: description.trim() || undefined,
        start_at: startIso,
        end_at: endIso,
        all_day: allDay,
        channel_id: payloadChannelId,
        standalone_call_id: standaloneCallId,
        attendee_ids: contextChannelId ? [...attendees] : undefined,
        post_card: !!payloadChannelId && postCard,
      })
      toastSuccess('Meeting scheduled.')
      onClose()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not schedule the meeting.')
      setBusy(false)
    }
  }

  const memberChannels = channels.filter((c) => c.kind !== 'dm' && c.is_member)
  const dmChannels = channels.filter((c) => c.kind === 'dm')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-meeting-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex items-start gap-4 border-b border-[var(--color-border)] p-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]">
            <CalendarPlusIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="schedule-meeting-title" className="text-lg font-semibold">
              Schedule meeting
            </h2>
            <p className="mt-1 text-sm leading-5 text-[var(--color-text-dim)]">
              Put it on the shared agenda and, optionally, drop a card in a channel.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-faint)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-40"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={submit} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="meeting-label">Title</span>
            <input
              ref={inputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoComplete="off"
              className="mt-2 h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-base outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="meeting-label">{allDay ? 'Day' : 'Starts'}</span>
              <input
                type={allDay ? 'date' : 'datetime-local'}
                value={allDay ? startLocal.slice(0, 10) : startLocal}
                onChange={(e) =>
                  setStartLocal(allDay ? `${e.target.value}T00:00` : e.target.value)
                }
                className="mt-2 h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
              />
            </label>
            {!allDay && (
              <label className="block">
                <span className="meeting-label">Duration</span>
                <select
                  value={durationMin}
                  onChange={(e) => setDurationMin(Number(e.target.value))}
                  className="mt-2 h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                >
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d < 60 ? `${d} min` : `${d / 60} hr${d >= 120 ? 's' : ''}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-dim)]">
            <input
              type="checkbox"
              checked={allDay}
              onChange={(e) => setAllDay(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            All day
          </label>

          <label className="block">
            <span className="meeting-label">Context</span>
            <select
              value={context}
              onChange={(e) => setContext(e.target.value)}
              className="mt-2 h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-sm outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            >
              <option value="none">None (calendar only)</option>
              <option value="standalone">Standalone call</option>
              {memberChannels.length > 0 && (
                <optgroup label="Channels">
                  {memberChannels.map((c) => (
                    <option key={c.id} value={`channel:${c.id}`}>
                      #{c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {dmChannels.length > 0 && (
                <optgroup label="Direct messages">
                  {dmChannels.map((c) => (
                    <option key={c.id} value={`channel:${c.id}`}>
                      {channelLabel(c)}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>

          {contextChannelId && (
            <div>
              <span className="meeting-label">Attendees</span>
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-2">
                {directory.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-[var(--color-text-faint)]">
                    No members to invite.
                  </p>
                ) : (
                  directory.map((u) => (
                    <label
                      key={u.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--color-panel)]"
                    >
                      <input
                        type="checkbox"
                        checked={attendees.has(u.id)}
                        onChange={() => toggleAttendee(u.id)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="truncate text-[var(--color-text-dim)]">
                        {u.display_name}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          <label className="block">
            <span className="meeting-label">Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              maxLength={2000}
              className="mt-2 w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
              placeholder="Agenda, links, notes…"
            />
          </label>

          {contextChannelId && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--color-text-dim)]">
              <input
                type="checkbox"
                checked={postCard}
                onChange={(e) => setPostCard(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              Post a card to the channel
            </label>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="meeting-button h-11 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || busy}
              className="meeting-button-primary h-11 min-w-28 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function CalendarPlusIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M12 13v4M10 15h4" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}
