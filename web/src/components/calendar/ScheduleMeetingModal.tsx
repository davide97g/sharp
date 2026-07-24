import { effectiveNicknames } from '../../lib/displayName'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { toastError, toastSuccess } from '../../lib/toast'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import type { ScheduledMeeting } from '../../lib/types'
import { Button, Input, Modal, Select, Textarea } from '../../ui'
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
 * Modal (built on the ui Modal primitive) for scheduling a native meeting.
 * `channelId` prefills the channel context and defaults attendees to its members.
 * When `meeting` is passed the modal switches to EDIT mode: context is immutable
 * (hidden), the attendee picker is always shown, and submit PATCHes the meeting.
 */
export function ScheduleMeetingModal({
  onClose,
  channelId,
  meeting,
}: {
  onClose: () => void
  channelId?: string | null
  meeting?: ScheduledMeeting
}) {
  const channels = useStore((s) => s.channels)
  const nicknames = useStore(effectiveNicknames)
  const users = useStore((s) => s.users)
  const membersByChannel = useStore((s) => s.members)
  const loadMembers = useStore((s) => s.loadMembers)
  const createScheduledMeeting = useStore((s) => s.createScheduledMeeting)
  const updateScheduledMeeting = useStore((s) => s.updateScheduledMeeting)

  const isEdit = !!meeting

  const prefillChannel = channelId
    ? channels.find((c) => c.id === channelId)
    : undefined

  const initialDuration = meeting
    ? Math.max(1, dayjs(meeting.end_at).diff(dayjs(meeting.start_at), 'minute'))
    : 30

  const [title, setTitle] = useState(
    meeting
      ? meeting.title
      : prefillChannel
        ? `Meeting in ${channelLabel(prefillChannel, nicknames)}`
        : 'Meeting',
  )
  const [startLocal, setStartLocal] = useState(() =>
    isoToDatetimeLocal(meeting ? meeting.start_at : nextHalfHourIso()),
  )
  const [durationMin, setDurationMin] = useState(initialDuration)
  const [allDay, setAllDay] = useState(meeting ? meeting.all_day : false)
  const [context, setContext] = useState<Context>(
    channelId ? `channel:${channelId}` : 'none',
  )
  const [description, setDescription] = useState(meeting?.description ?? '')
  const [postCard, setPostCard] = useState(!!channelId)
  const [attendees, setAttendees] = useState<Set<string>>(
    () => new Set(meeting ? meeting.attendees.map((a) => a.user_id) : []),
  )
  const [busy, setBusy] = useState(false)

  // In edit mode the Duration select includes the meeting's actual length even
  // when it doesn't match a preset.
  const durationOptions = useMemo(
    () =>
      DURATIONS.includes(initialDuration)
        ? DURATIONS
        : [...DURATIONS, initialDuration].sort((a, b) => a - b),
    [initialDuration],
  )

  const inputRef = useRef<HTMLInputElement>(null)

  const contextChannelId = context.startsWith('channel:')
    ? context.slice('channel:'.length)
    : null

  // Load + default attendees to the selected channel's members.
  useEffect(() => {
    if (!contextChannelId) return
    void loadMembers(contextChannelId)
  }, [contextChannelId, loadMembers])

  useEffect(() => {
    if (isEdit) return // edit mode keeps the meeting's own attendee set
    if (!contextChannelId) return
    const members = membersByChannel[contextChannelId]
    if (members) setAttendees(new Set(members.map((m) => m.id)))
  }, [isEdit, contextChannelId, membersByChannel])

  useEffect(() => {
    inputRef.current?.select()
  }, [])

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

      if (meeting) {
        await updateScheduledMeeting(meeting.id, {
          title: value,
          description: description.trim(),
          start_at: startIso,
          end_at: endIso,
          all_day: allDay,
          attendee_ids: [...attendees],
        })
        toastSuccess('Meeting updated.')
        onClose()
        return
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
    <Modal
      title={isEdit ? 'Edit meeting' : 'Schedule meeting'}
      onClose={onClose}
      size="lg"
      initialFocusRef={inputRef}
      headerIcon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-hover ring-1 ring-accent">
          <CalendarPlusIcon />
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="schedule-meeting-form" disabled={!title.trim() || busy} className="min-w-28">
            {busy ? (isEdit ? 'Saving…' : 'Scheduling…') : isEdit ? 'Save' : 'Schedule'}
          </Button>
        </>
      }
    >
      <form id="schedule-meeting-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm leading-5 text-text-dim">
          {isEdit
            ? 'Update the details and attendees for this meeting.'
            : 'Put it on the shared agenda and, optionally, drop a card in a channel.'}
        </p>

        <label className="block">
          <span className="meeting-label">Title</span>
          <Input
            ref={inputRef}
            uiSize="lg"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            autoComplete="off"
            className="mt-2"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="meeting-label">{allDay ? 'Day' : 'Starts'}</span>
            <Input
              uiSize="lg"
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? startLocal.slice(0, 10) : startLocal}
              onChange={(e) =>
                setStartLocal(allDay ? `${e.target.value}T00:00` : e.target.value)
              }
              className="mt-2"
            />
          </label>
          {!allDay && (
            <label className="block">
              <span className="meeting-label">Duration</span>
              <Select
                uiSize="lg"
                value={durationMin}
                onChange={(e) => setDurationMin(Number(e.target.value))}
                className="mt-2"
              >
                {durationOptions.map((d) => (
                  <option key={d} value={d}>
                    {d < 60 ? `${d} min` : `${d / 60} hr${d >= 120 ? 's' : ''}`}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dim">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          All day
        </label>

        {!isEdit && (
          <label className="block">
            <span className="meeting-label">Context</span>
            <Select
              uiSize="lg"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              className="mt-2"
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
                      {channelLabel(c, nicknames)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </label>
        )}

        {(isEdit || contextChannelId) && (
          <div>
            <span className="meeting-label">Attendees</span>
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border bg-panel-2 p-2">
              {directory.length === 0 ? (
                <p className="px-1 py-2 text-xs text-text-faint">
                  No members to invite.
                </p>
              ) : (
                directory.map((u) => (
                  <label
                    key={u.id}
                    className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-panel"
                  >
                    <input
                      type="checkbox"
                      checked={attendees.has(u.id)}
                      onChange={() => toggleAttendee(u.id)}
                      className="h-4 w-4 accent-[var(--color-accent)]"
                    />
                    <span className="truncate text-text-dim">
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
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            maxLength={2000}
            className="mt-2 resize-none"
            placeholder="Agenda, links, notes…"
          />
        </label>

        {!isEdit && contextChannelId && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-dim">
            <input
              type="checkbox"
              checked={postCard}
              onChange={(e) => setPostCard(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Post a card to the channel
          </label>
        )}
      </form>
    </Modal>
  )
}

function CalendarPlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M12 13v4M10 15h4" />
    </svg>
  )
}
