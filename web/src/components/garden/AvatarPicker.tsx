import { useState } from 'react'
import { Button, Modal, ModalFooter } from '../../ui'
import {
  AVATAR_IDS,
  AVATAR_LABELS,
  avatarFacesetUrl,
  type GardenAvatarId,
} from './gardenAvatars'

type Props = {
  /** Current choice, or null when this person has never picked one. */
  value: string | null
  /**
   * Roster the server will actually accept. Falls back to the local list when a
   * server predates the field, so the picker can never offer a rejected id.
   */
  allowed?: string[]
  onClose: () => void
  onChoose: (avatar: GardenAvatarId) => void
}

/**
 * Character picker, shown once on first Garden entry and reopenable from the
 * gear menu.
 *
 * Deliberately dismissible: Garden is somewhere people go to relax, so gating
 * entry behind a modal is the wrong trade. Skipping keeps the deterministic
 * fallback, which already looks correct and distinct to everyone else.
 */
export function AvatarPicker({ value, allowed, onClose, onChoose }: Props) {
  const roster = (allowed?.length ? allowed : AVATAR_IDS).filter((id): id is GardenAvatarId =>
    (AVATAR_IDS as readonly string[]).includes(id),
  )
  const [selected, setSelected] = useState<GardenAvatarId | null>(
    (value as GardenAvatarId | null) ?? null,
  )

  return (
    <Modal
      onClose={onClose}
      title={value ? 'Change your character' : 'Pick your character'}
      footer={
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>
            {value ? 'Cancel' : 'Skip for now'}
          </Button>
          <Button
            disabled={!selected || selected === value}
            onClick={() => {
              if (selected) onChoose(selected)
            }}
          >
            {value ? 'Save' : 'Enter the Garden'}
          </Button>
        </ModalFooter>
      }
    >
      <p className="mb-3 text-xs text-[var(--color-text-faint)]">
        Everyone in the Garden sees you as this character. You can change it any time from
        the gear menu.
      </p>
      <div
        role="radiogroup"
        aria-label="Garden character"
        className="grid grid-cols-3 gap-2 sm:grid-cols-4"
      >
        {roster.map((id) => {
          const active = selected === id
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSelected(id)}
              className={`flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 transition-colors motion-reduce:transition-none ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                  : 'border-[var(--color-border)] bg-[var(--color-panel-2)] hover:border-[var(--color-border-soft)]'
              }`}
            >
              <img
                src={avatarFacesetUrl(id)}
                alt=""
                width={38}
                height={38}
                draggable={false}
                // Pixel art: never let the browser smooth it.
                style={{ imageRendering: 'pixelated' }}
                className="h-[38px] w-[38px] shrink-0"
              />
              <span
                className={`text-2xs font-medium ${
                  active ? 'text-[var(--color-text)]' : 'text-[var(--color-text-dim)]'
                }`}
              >
                {AVATAR_LABELS[id]}
              </span>
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
