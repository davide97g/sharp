// Settings → Notifications: per-type switches, Do-Not-Disturb, and quiet hours.
//
// Contract: docs/arch/05-files-notifications.md ("Notification semantics").
//
// These are real server columns rather than the appearance blob because the *server*
// enforces them — see server/src/routes/prefs.rs. Quiet hours are stored as minutes past
// local midnight and converted with minutesToHhmm/hhmmToMinutes from lib/util.

import { hhmmToMinutes, minutesToHhmm } from '../../lib/util'
import { useStore } from '../../store'
import type {
  ChannelNotifyMode,
} from '../../lib/types'
import { Input, SectionLabel } from '../../ui'
import { NotificationSetup } from '../NotificationSetup'
import { SoundSettingsSection } from './AppearanceSettings'


export const DEFAULT_QUIET_START = 22 * 60 // 22:00
export const DEFAULT_QUIET_END = 7 * 60 // 07:00

/** Quiet-hours inputs fall back to the defaults above when the pref is unset. */
export function minutesToHHMM(min: number | null, fallback: number): string {
  return minutesToHhmm(min ?? fallback)
}

export type DndModeChoice = 'off' | 'on' | 'scheduled'

export function NotificationsSettings() {
  const dnd = useStore((s) => s.dnd)
  const dndScheduled = useStore((s) => s.dndScheduled)
  const dndStart = useStore((s) => s.dndStart)
  const dndEnd = useStore((s) => s.dndEnd)
  const setDnd = useStore((s) => s.setDnd)
  const updateNotifyPrefs = useStore((s) => s.updateNotifyPrefs)
  const notifyDm = useStore((s) => s.notifyDm)
  const notifyMention = useStore((s) => s.notifyMention)
  const notifyReply = useStore((s) => s.notifyReply)
  const notifyTask = useStore((s) => s.notifyTask)
  const notifyPoll = useStore((s) => s.notifyPoll)
  const channels = useStore((s) => s.channels)
  const channelModes = useStore((s) => s.channelModes)
  const setChannelMode = useStore((s) => s.setChannelMode)

  const dndMode: DndModeChoice = dnd ? 'on' : dndScheduled ? 'scheduled' : 'off'
  const tzOffset = -new Date().getTimezoneOffset() // minutes east of UTC

  async function selectDndMode(next: DndModeChoice) {
    if (next === 'off') {
      await Promise.all([setDnd(false), updateNotifyPrefs({ dnd_scheduled: false })])
    } else if (next === 'on') {
      await Promise.all([setDnd(true), updateNotifyPrefs({ dnd_scheduled: false })])
    } else {
      await Promise.all([
        setDnd(false),
        updateNotifyPrefs({
          dnd_scheduled: true,
          dnd_start: dndStart ?? DEFAULT_QUIET_START,
          dnd_end: dndEnd ?? DEFAULT_QUIET_END,
          tz_offset: tzOffset,
        }),
      ])
    }
  }

  const memberChannels = channels.filter((c) => c.is_member)

  const TYPES: { key: string; label: string; hint: string; value: boolean; field: string }[] = [
    { key: 'dm', label: 'Direct messages', hint: 'New messages in your DMs.', value: notifyDm, field: 'notify_dm' },
    { key: 'mention', label: 'Mentions & @all', hint: 'When someone @-mentions you or the channel.', value: notifyMention, field: 'notify_mention' },
    { key: 'reply', label: 'Thread replies', hint: 'Replies to threads you started.', value: notifyReply, field: 'notify_reply' },
    { key: 'task', label: 'Task activity', hint: 'Assigned a task or a new comment on one.', value: notifyTask, field: 'notify_task' },
    { key: 'poll', label: 'Poll results', hint: 'When a poll you created or voted in ends.', value: notifyPoll, field: 'notify_poll' },
  ]

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <SectionLabel size="xs">Delivery</SectionLabel>
        <NotificationSetup />
        <p className="text-2xs leading-5 text-[var(--color-text-faint)]">
          Push works on this website, installed PWAs (macOS &amp; iOS Home-Screen app), and the
          desktop app. Enable it once per device.
        </p>
      </section>

      <SoundSettingsSection />

      <section className="flex flex-col gap-3">
        <SectionLabel size="xs">Do Not Disturb</SectionLabel>
        <div className="flex flex-col gap-2">
          {(
            [
              { value: 'off', label: 'Off', hint: 'Deliver notifications normally.' },
              { value: 'on', label: 'On', hint: 'Silence all push, toasts, and sounds.' },
              { value: 'scheduled', label: 'Scheduled', hint: 'Quiet during set hours each day.' },
            ] as { value: DndModeChoice; label: string; hint: string }[]
          ).map((opt) => (
            <label
              key={opt.value}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
            >
              <input
                type="radio"
                name="dnd-mode"
                checked={dndMode === opt.value}
                onChange={() => void selectDndMode(opt.value)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-sm font-medium text-[var(--color-text)]">{opt.label}</span>
                <span className="mt-0.5 block text-xs text-[var(--color-text-faint)]">{opt.hint}</span>
              </span>
            </label>
          ))}
        </div>
        {dndMode === 'scheduled' && (
          <div className="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
            <label className="flex flex-col gap-1">
              <SectionLabel as="span" size="2xs">From</SectionLabel>
              <Input
                type="time"
                uiSize="sm"
                surface="panel"
                value={minutesToHHMM(dndStart, DEFAULT_QUIET_START)}
                onChange={(e) =>
                  void updateNotifyPrefs({ dnd_start: hhmmToMinutes(e.target.value), tz_offset: tzOffset })
                }
              />
            </label>
            <label className="flex flex-col gap-1">
              <SectionLabel as="span" size="2xs">To</SectionLabel>
              <Input
                type="time"
                uiSize="sm"
                surface="panel"
                value={minutesToHHMM(dndEnd, DEFAULT_QUIET_END)}
                onChange={(e) =>
                  void updateNotifyPrefs({ dnd_end: hhmmToMinutes(e.target.value), tz_offset: tzOffset })
                }
              />
            </label>
            <p className="min-w-[8rem] flex-1 text-2xs leading-5 text-[var(--color-text-faint)]">
              Uses this device&rsquo;s time zone. Windows past midnight are fine.
            </p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionLabel size="xs">Notify me about</SectionLabel>
        {TYPES.map((t) => (
          <label
            key={t.key}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3"
          >
            <input
              type="checkbox"
              checked={t.value}
              onChange={(e) => void updateNotifyPrefs({ [t.field]: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              <span className="block text-sm font-medium text-[var(--color-text)]">{t.label}</span>
              <span className="mt-0.5 block text-xs text-[var(--color-text-faint)]">{t.hint}</span>
            </span>
          </label>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <SectionLabel size="xs">Per-channel</SectionLabel>
          <p className="mt-1 text-2xs text-[var(--color-text-faint)]">
            Override the defaults above for a specific conversation.
          </p>
        </div>
        {memberChannels.length === 0 ? (
          <p className="text-sm text-[var(--color-text-dim)]">No channels yet.</p>
        ) : (
          <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {memberChannels.map((c) => {
              const label = c.kind === 'dm' ? c.dm_user?.display_name ?? 'Direct message' : `# ${c.name}`
              const mode = (channelModes[c.id] ?? 'all') as ChannelNotifyMode
              return (
                <div key={c.id} className="flex items-center justify-between gap-3 p-3">
                  <span className="min-w-0 truncate text-sm text-[var(--color-text)]">{label}</span>
                  {/* TODO(ds): kept bespoke — Select primitive is w-full (cn has no tailwind-merge), which breaks this shrink-0 inline row. */}
                  <select
                    value={mode}
                    onChange={(e) => void setChannelMode(c.id, e.target.value as ChannelNotifyMode)}
                    className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    <option value="all">All messages</option>
                    <option value="mentions">Mentions only</option>
                    <option value="muted">Muted</option>
                  </select>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
