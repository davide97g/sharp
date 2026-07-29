// Settings → Chat: message layout, timestamps, avatars, grouping.
//
// Presentation only, so it all lives in the synced appearance blob.

import { useStore } from '../../store'
import type {
  ChatLayout,
} from '../../lib/types'
import { Button, ChoiceCard, SectionLabel } from '../../ui'
import { ChatLayoutPicker } from '../ChatLayoutChooser'
import type {
  AvatarShape,
  MessageLayout,
  TimestampStyle,
} from '../../lib/uiPrefs'
import { Segmented, ToggleRow } from './shared'


export const CHANNEL_LAYOUTS: { value: MessageLayout; label: string; desc: string }[] = [
  { value: 'classic', label: 'Classic', desc: 'Avatar rows with author headers.' },
  { value: 'bubble', label: 'Bubbles', desc: 'Yours right, theirs left.' },
  { value: 'irc', label: 'IRC', desc: 'One line each: time, name, message.' },
]

export const TIMESTAMP_CHOICES: { value: TimestampStyle; label: string }[] = [
  { value: 'hover', label: 'On hover' },
  { value: 'clock24', label: '24-hour' },
  { value: 'clock12', label: '12-hour' },
  { value: 'relative', label: 'Relative' },
]

export const AVATAR_CHOICES: { value: AvatarShape; label: string }[] = [
  { value: 'circle', label: 'Circle' },
  { value: 'squircle', label: 'Rounded' },
  { value: 'square', label: 'Square' },
]

export const GROUP_WINDOWS = [0, 1, 5, 15, 60]

export function ChatSettings({
  chatLayout,
  onChatLayout,
}: {
  chatLayout: ChatLayout | null
  onChatLayout: (layout: ChatLayout) => void
}) {
  const ui = useStore((s) => s.ui)
  const patchUi = useStore((s) => s.patchUi)
  const overrideCount = Object.keys(ui.channelLayoutOverrides).length

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel size="xs">Direct message layout</SectionLabel>
      <ChatLayoutPicker value={chatLayout} onChange={onChatLayout} />

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Channel layout
        </SectionLabel>
        <div className="grid grid-cols-3 gap-3">
          {CHANNEL_LAYOUTS.map((l) => (
            <ChoiceCard
              key={l.value}
              selected={ui.channelLayout === l.value}
              onSelect={() => patchUi({ channelLayout: l.value })}
              title={l.label}
              description={l.desc}
              selectedStyle="ring"
            />
          ))}
        </div>
        {overrideCount > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <p className="text-2xs text-text-faint">
              {overrideCount} channel{overrideCount === 1 ? '' : 's'} override this.
            </p>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => patchUi({ channelLayoutOverrides: {} })}
            >
              Clear overrides
            </Button>
          </div>
        )}
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Timestamps
        </SectionLabel>
        <Segmented
          value={ui.timestampStyle}
          options={TIMESTAMP_CHOICES}
          onChange={(value) => patchUi({ timestampStyle: value })}
        />
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Avatars
        </SectionLabel>
        <Segmented
          value={ui.avatarShape}
          options={AVATAR_CHOICES}
          onChange={(value) => patchUi({ avatarShape: value })}
        />
      </div>

      <div className="mt-3 border-t border-border pt-5">
        <SectionLabel size="xs" className="mb-3">
          Group messages
        </SectionLabel>
        <Segmented
          value={ui.groupWindowMin}
          options={GROUP_WINDOWS.map((m) => ({
            value: m,
            label: m === 0 ? 'Never' : `${m} min`,
          }))}
          onChange={(value) => patchUi({ groupWindowMin: value })}
        />
        <p className="mt-2 text-2xs text-text-faint">
          Consecutive messages from one person collapse into a block within this
          window.
        </p>
      </div>

      <div className="mt-3 border-t border-border pt-5 flex flex-col gap-4">
        <ToggleRow
          title="Colour author names"
          description="Give everyone a consistent colour, IRC-style."
          checked={ui.nameColors}
          onChange={(nameColors) => patchUi({ nameColors })}
        />
        <ToggleRow
          title="Show link previews"
          description="Cards under messages that link out. Images load through your server, never from the linked site."
          checked={ui.linkPreviews}
          onChange={(linkPreviews) => patchUi({ linkPreviews })}
        />
      </div>
    </div>
  )
}


// ---- Appearance tab ----
