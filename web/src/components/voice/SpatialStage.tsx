// Spatial call view: a floor plan of the room where everyone stands somewhere and
// you hear them from that direction and distance.
//
// Contract: docs/arch/04-voice.md (`voice.move` / `voice.participant_moved`).
//
// Two halves that must not be confused:
//   - Positions are ROOM state. They come from the server, are shared by everyone,
//     and only your own avatar is yours to move (store action `moveVoiceSelf`).
//   - Panning is a LISTENER concern. It lives entirely in lib/voice.ts and is driven
//     from `useSpatialAudio`, which is mounted by the stage shell rather than this
//     component — minimizing the call must not silence the positional audio.
//
// Coordinates are the same normalized 0..1 pair everywhere (x = left→right,
// y = top→bottom). The floor is drawn to whatever aspect the panel has; only the
// numbers are authoritative, never the pixels.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { Badge, Kbd } from '../../ui'
import { AudioAuraAvatar } from './AudioAuraAvatar'
import { HandIcon, MicIcon } from './callIcons'

/** Keyboard step per press, and the larger step while Shift is held. */
const STEP = 0.035
const STEP_FAST = 0.1
/** Radius (in floor units) of the "clear voice" ring drawn around you — mirrors
 *  the panner's reference distance, so the ring is where people start to fade. */
const CLEAR_RADIUS = 0.19

type SpatialPerson = {
  connId: string
  userId: string
  name: string
  guest: boolean
  muted: boolean
  handRaised: boolean
  speaking: boolean
  cameraOn: boolean
  x: number
  y: number
  local: boolean
}

/**
 * Push every participant's floor position into the audio engine while the spatial
 * view is on. Mount this once per call from a component that stays mounted in all
 * stage modes (VideoStage does) — not from the floor plan, which unmounts.
 */
export function useSpatialAudio() {
  const channelId = useStore((s) => s.voice.channelId)
  const spatial = useStore((s) => s.voice.spatial)
  const client = useStore((s) => s.voice.client)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))

  useEffect(() => {
    if (!client || !spatial || !room) return
    for (const [connId, entry] of Object.entries(room)) {
      client.setSpatialPosition(connId, entry.pos_x, entry.pos_y)
    }
  }, [client, spatial, room])
}

export function SpatialStage({
  resolveName,
  audioAuraEnabled,
  compact = false,
}: {
  resolveName: (userId: string, roomName?: string) => string
  audioAuraEnabled: boolean
  compact?: boolean
}) {
  const channelId = useStore((s) => s.voice.channelId)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const speaking = useStore((s) => s.voice.speaking)
  const myConnId = useStore((s) => s.myConnId)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const moveVoiceSelf = useStore((s) => s.moveVoiceSelf)
  const floorRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const people = useMemo<SpatialPerson[]>(() => {
    return Object.entries(room ?? {}).map(([connId, entry]) => ({
      connId,
      userId: entry.user_id,
      name: resolveName(entry.user_id, entry.display_name),
      guest: entry.guest,
      muted: entry.muted,
      handRaised: entry.hand_raised,
      speaking: Boolean(speaking[connId]),
      cameraOn: entry.camera_on,
      x: entry.pos_x,
      y: entry.pos_y,
      local: connId === myConnId,
    }))
  }, [room, resolveName, speaking, myConnId])

  const self = people.find((person) => person.local) ?? null
  const avatarSize = compact ? 40 : 64

  // Pointer position → floor coordinates. Reading the rect per event keeps this
  // correct while the call panel is being resized or dragged around.
  const pointToFloor = (clientX: number, clientY: number) => {
    const rect = floorRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    }
  }

  const moveTo = (clientX: number, clientY: number) => {
    const point = pointToFloor(clientX, clientY)
    if (point) moveVoiceSelf(point.x, point.y)
  }

  const onFloorPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !self) return
    // Walk to a tapped spot, then keep following the pointer — one gesture covers
    // both "go there" and "drag me around".
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    moveTo(event.clientX, event.clientY)
  }

  const onFloorPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    moveTo(event.clientX, event.clientY)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!self || event.defaultPrevented) return
    const step = event.shiftKey ? STEP_FAST : STEP
    let dx = 0
    let dy = 0
    switch (event.key) {
      case 'ArrowLeft':
      case 'a':
      case 'A':
        dx = -step
        break
      case 'ArrowRight':
      case 'd':
      case 'D':
        dx = step
        break
      case 'ArrowUp':
      case 'w':
      case 'W':
        dy = -step
        break
      case 'ArrowDown':
      case 's':
      case 'S':
        dy = step
        break
      default:
        return
    }
    event.preventDefault()
    moveVoiceSelf(self.x + dx, self.y + dy)
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={floorRef}
        role="application"
        aria-label="Spatial room floor — arrow keys or WASD to move"
        tabIndex={0}
        onPointerDown={onFloorPointerDown}
        onPointerMove={onFloorPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={`spatial-floor relative min-h-0 flex-1 touch-none overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          dragging ? 'cursor-grabbing' : 'cursor-pointer'
        }`}
      >
        {self && (
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-full border border-dashed border-[var(--color-accent)]/35 bg-[var(--color-accent)]/6"
            style={{
              left: `${self.x * 100}%`,
              top: `${self.y * 100}%`,
              width: `${CLEAR_RADIUS * 200}%`,
              height: `${CLEAR_RADIUS * 200}%`,
              transform: 'translate(-50%, -50%)',
            }}
          />
        )}
        {people.map((person) => (
          <FloorAvatar
            key={person.connId}
            person={person}
            self={self}
            size={avatarSize}
            dragging={dragging && person.local}
            audioAuraEnabled={audioAuraEnabled}
            stream={
              person.cameraOn
                ? person.local
                  ? localStream
                  : remoteStreams[person.connId] ?? null
                : null
            }
          />
        ))}
      </div>
      {!compact && (
        <p className="shrink-0 text-center text-2xs text-[var(--color-text-faint)]">
          Drag yourself or click the floor to walk · <Kbd>W</Kbd> <Kbd>A</Kbd> <Kbd>S</Kbd>{' '}
          <Kbd>D</Kbd> to step · voices come from where people stand
        </p>
      )}
    </div>
  )
}

function FloorAvatar({
  person,
  self,
  size,
  dragging,
  audioAuraEnabled,
  stream,
}: {
  person: SpatialPerson
  self: SpatialPerson | null
  size: number
  dragging: boolean
  audioAuraEnabled: boolean
  stream: MediaStream | null
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) video.srcObject = stream
  }, [stream])

  // Distance to the listener drives depth: further away is smaller and dimmer, so
  // the picture agrees with what the ears are being told.
  const distance = self
    ? Math.hypot(person.x - self.x, person.y - self.y)
    : 0
  const opacity = person.local ? 1 : Math.max(0.4, 1 - distance * 0.62)
  const scale = person.local ? 1 : Math.max(0.78, 1 - distance * 0.2)

  return (
    <div
      className={`absolute flex select-none flex-col items-center gap-1 ${
        dragging ? '' : 'transition-[left,top] duration-100 ease-out motion-reduce:transition-none'
      }`}
      style={{
        left: `${person.x * 100}%`,
        top: `${person.y * 100}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        opacity,
        zIndex: person.local ? 2 : 1,
        cursor: person.local ? (dragging ? 'grabbing' : 'grab') : 'default',
      }}
    >
      <div
        className={`relative rounded-full ${
          person.local
            ? 'ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-panel)]'
            : person.speaking && !audioAuraEnabled
              ? 'ring-2 ring-success ring-offset-2 ring-offset-[var(--color-panel)]'
              : ''
        }`}
      >
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="rounded-full bg-[var(--color-panel-2)] object-cover"
            style={{ width: size, height: size, transform: person.local ? 'scaleX(-1)' : undefined }}
          />
        ) : (
          <AudioAuraAvatar
            userId={person.userId}
            name={person.name}
            size={size}
            connIds={[person.connId]}
            speaking={person.speaking}
            enabled={audioAuraEnabled}
          />
        )}
        {person.handRaised && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--color-panel)] bg-amber-400 text-[#3a2a00]"
            title="Hand raised"
          >
            <HandIcon compact />
          </span>
        )}
        {person.muted && (
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[var(--color-panel)] bg-[var(--color-panel-2)] text-[var(--color-text-dim)]"
            title="Muted"
          >
            <MicIcon off />
          </span>
        )}
      </div>
      <span className="flex max-w-28 items-center gap-1 truncate rounded-full bg-[var(--color-ink)]/70 px-2 py-0.5 text-2xs font-medium text-[var(--color-text)]">
        <span className="truncate">
          {person.name}
          {person.local ? ' (you)' : ''}
        </span>
        {person.guest && (
          <Badge tone="neutral" variant="outline">
            Guest
          </Badge>
        )}
      </span>
    </div>
  )
}
