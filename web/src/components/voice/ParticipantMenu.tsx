// Per-person controls inside a call, hung off the participant tiles.
//
// Two very different actions live here, and the wording is what keeps them apart:
//   - **Mute for me** is playback. Device-local, instant, reversible, tells nobody.
//   - **Mute for everyone** is the room. It sends `voice.force_mute`, so it gets the
//     one confirm step in the whole call UI — the cost of a mis-tap is somebody else's
//     microphone. There is no force-*unmute* to offer: only they can re-open it.
//
// Never rendered for yourself; your own mic is the controls bar.
//
// The trigger is a render prop because each surface needs a different affordance: a
// floating button over a video frame, a whole name row on a small avatar tile (where a
// 44px icon button would leave no room for the name), a pill on the spatial floor.
import { useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { Button, Menu, MenuItem, MenuLabel, MenuSeparator } from '../../ui'
import { MicIcon, SpeakerIcon } from './callIcons'

export function ParticipantMenu({
  userId,
  name,
  connIds,
  muted,
  trigger,
  align = 'end',
  side = 'bottom',
}: {
  userId: string
  name: string
  /** Every connection this person has: a second device must not be a way around a mute. */
  connIds: string[]
  /** Server-side mic state — true only when all of their connections are muted. */
  muted: boolean
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const locallyMuted = useStore((s) => s.voice.locallyMutedUsers.has(userId))
  const connected = useStore((s) => s.voice.status === 'connected')
  const togglePeerLocalMute = useStore((s) => s.togglePeerLocalMute)
  const forceMuteParticipant = useStore((s) => s.forceMuteParticipant)

  function close() {
    setOpen(false)
    setConfirming(false)
  }

  return (
    <Menu
      open={open}
      onClose={close}
      align={align}
      side={side}
      width="w-60"
      trigger={trigger({ open, toggle: () => (open ? close() : setOpen(true)) })}
    >
      {confirming ? (
        <div className="p-2">
          <p className="text-sm font-medium text-text">Mute {name} for everyone?</p>
          <p className="mt-1 text-2xs text-text-faint">
            Everyone stops hearing them until they unmute themselves. You cannot turn their
            microphone back on.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                for (const connId of connIds) forceMuteParticipant(connId)
                close()
              }}
            >
              Mute
            </Button>
          </div>
        </div>
      ) : (
        <>
          <MenuLabel>{name}</MenuLabel>
          <MenuItem
            icon={<SpeakerIcon off={!locallyMuted} />}
            onClick={() => {
              togglePeerLocalMute(userId)
              close()
            }}
          >
            {locallyMuted ? 'Unmute for me' : 'Mute for me'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<MicIcon off />}
            disabled={muted || !connected}
            trailing={muted ? <span className="text-2xs text-text-faint">Muted</span> : undefined}
            onClick={() => setConfirming(true)}
          >
            Mute for everyone
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

export function ParticipantMenuDots({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="12" cy="5" r="1.9" />
      <circle cx="12" cy="12" r="1.9" />
      <circle cx="12" cy="19" r="1.9" />
    </svg>
  )
}
