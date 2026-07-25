import { useState } from 'react'
import { useStore } from '../store'
import {
  SHORTCUTS,
  chordFor,
  conflicts,
  formatChord,
  shortcutGroups,
  type ShortcutDef,
} from '../lib/shortcuts'
import { Banner, Button, Kbd, Modal, SectionLabel } from '../ui'

// The cheat sheet is generated from the registry, never hand-written — that is
// the point of having a registry. It doubles as the remapping surface: press a
// key combination while a row is armed and the new chord is stored in the
// synced `ui.shortcuts` map.

function chordFromEvent(e: React.KeyboardEvent): string | null {
  const key = e.key.toLowerCase()
  // Modifier-only presses are the user still assembling the chord.
  if (['shift', 'control', 'alt', 'meta', 'os'].includes(key)) return null
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey && key !== '?') parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

function Row({
  def,
  armed,
  onArm,
  onAssign,
}: {
  def: ShortcutDef
  armed: boolean
  onArm: () => void
  onAssign: (chord: string) => void
}) {
  const chord = chordFor(def.id)
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0 text-sm text-text">{def.label}</span>
      {def.displayOnly ? (
        <span className="shrink-0 text-2xs text-text-faint">{def.displayOnly}</span>
      ) : (
        <button
          type="button"
          onClick={onArm}
          onKeyDown={(e) => {
            if (!armed) return
            e.preventDefault()
            if (e.key === 'Escape') return onArm()
            const next = chordFromEvent(e)
            if (next) onAssign(next)
          }}
          className={`shrink-0 rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent ${
            armed ? 'ring-2 ring-accent' : ''
          }`}
          aria-label={`Change shortcut for ${def.label}`}
        >
          {armed ? (
            <span className="text-2xs text-accent-hover">Press keys…</span>
          ) : (
            <Kbd>{formatChord(chord)}</Kbd>
          )}
        </button>
      )}
    </div>
  )
}

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const remaps = useStore((s) => s.ui.shortcuts)
  const patchUi = useStore((s) => s.patchUi)
  const [armed, setArmed] = useState<string | null>(null)
  const clashes = conflicts()

  const assign = (id: string, chord: string) => {
    patchUi({ shortcuts: { ...remaps, [id]: chord } })
    setArmed(null)
  }

  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} size="lg">
      {clashes.length > 0 && (
        <Banner tone="warning">
          {clashes
            .map((ids) =>
              ids
                .map((id) => SHORTCUTS.find((s) => s.id === id)?.label ?? id)
                .join(' and '),
            )
            .join('; ')}{' '}
          share a shortcut. The most specific context wins, so one of them may
          look dead.
        </Banner>
      )}
      <div className="flex flex-col gap-5">
        {shortcutGroups().map((g) => (
          <div key={g.group}>
            <SectionLabel size="xs" className="mb-1">
              {g.group}
            </SectionLabel>
            <div className="divide-y divide-border-soft">
              {g.items.map((def) => (
                <Row
                  key={def.id}
                  def={def}
                  armed={armed === def.id}
                  onArm={() => setArmed(armed === def.id ? null : def.id)}
                  onAssign={(chord) => assign(def.id, chord)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-4">
        <p className="text-2xs text-text-faint">
          Click a shortcut to rebind it. Saved to your account.
        </p>
        <Button
          size="xs"
          variant="ghost"
          disabled={Object.keys(remaps).length === 0}
          onClick={() => patchUi({ shortcuts: {} })}
        >
          Reset to defaults
        </Button>
      </div>
    </Modal>
  )
}
