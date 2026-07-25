// Settings → Privacy: invisible mode, typing indicators, push previews, idle lock.
//
// Contract: docs/arch/05-files-notifications.md ("Privacy").
//
// The first three are server-enforced columns (server/src/privacy.rs) precisely because a
// privacy switch that only the client respects protects nobody.

import { useStore } from '../../store'
import type {
  PushPreview,
} from '../../lib/types'
import { chordFor, formatChord } from '../../lib/shortcuts'
import { SectionLabel } from '../../ui'
import { Segmented, ToggleRow } from './shared'
import type { Tab } from '../UserSettingsModal'


export const PUSH_PREVIEW_CHOICES: { value: PushPreview; label: string }[] = [
  { value: 'full', label: 'Show sender and message' },
  { value: 'generic', label: 'Just “new activity”' },
]

export const IDLE_LOCK_CHOICES = [0, 1, 5, 15, 30]

export function PrivacySettings({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const invisible = useStore((s) => s.invisible)
  const shareTyping = useStore((s) => s.shareTyping)
  const pushPreview = useStore((s) => s.pushPreview)
  const updateNotifyPrefs = useStore((s) => s.updateNotifyPrefs)
  const ui = useStore((s) => s.ui)
  const patchUi = useStore((s) => s.patchUi)

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel size="xs">What others can see</SectionLabel>
      <div className="flex flex-col gap-4">
        <ToggleRow
          title="Appear offline"
          description="You stay connected and keep receiving everything; nobody sees you online."
          checked={invisible}
          onChange={(value) => void updateNotifyPrefs({ invisible: value })}
        />
        <ToggleRow
          title="Share typing indicators"
          description="Off means nobody sees “you are typing”. You still see theirs."
          checked={shareTyping}
          onChange={(value) => void updateNotifyPrefs({ share_typing: value })}
        />
      </div>
      <p className="mt-1 text-2xs text-text-faint">
        Both are enforced by the server, not just hidden in this app.
      </p>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Notification previews
        </SectionLabel>
        <Segmented
          value={pushPreview}
          options={PUSH_PREVIEW_CHOICES}
          onChange={(value) => void updateNotifyPrefs({ push_preview: value })}
        />
        <p className="mt-2 text-2xs text-text-faint">
          Applies to push notifications shown by your OS or browser — the ones
          that appear when Sharp is closed. Encrypted DMs are always generic.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Lock the screen
        </SectionLabel>
        <Segmented
          value={ui.idleLockMin}
          options={IDLE_LOCK_CHOICES.map((m) => ({
            value: m,
            label: m === 0 ? 'Never' : `${m} min`,
          }))}
          onChange={(value) => patchUi({ idleLockMin: value })}
        />
        <p className="mt-2 text-2xs text-text-faint">
          Covers the screen after inactivity, or instantly with{' '}
          {formatChord(chordFor('privacy.lock'))}. This hides the screen from the
          room — it does not sign you out, so sign out if you are leaving the
          device.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Elsewhere
        </SectionLabel>
        <div className="flex flex-col gap-2">
          <PrivacyLink
            label="Streaming shield"
            description="Blur private conversations while sharing a screen."
            onClick={() => onOpen('streaming')}
          />
          <PrivacyLink
            label="Encryption"
            description="Trusted devices, safety numbers, and encrypted backups."
            onClick={() => onOpen('encryption')}
          />
          <PrivacyLink
            label="Security"
            description="Passkeys and sign-in."
            onClick={() => onOpen('security')}
          />
        </div>
      </div>
    </div>
  )
}

export function PrivacyLink({
  label,
  description,
  onClick,
}: {
  label: string
  description: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text">{label}</span>
        <span className="block text-2xs text-text-faint">{description}</span>
      </span>
      <span aria-hidden className="shrink-0 text-text-faint">
        →
      </span>
    </button>
  )
}

// ---- Chat tab ----
