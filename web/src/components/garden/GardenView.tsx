import { useEffect, useMemo, useRef, useState } from 'react'
import type { GardenMap, GardenRoom } from '../../lib/types'
import { sound } from '../../lib/sound'
import { gardenColor } from '../../lib/gardenColors'
import { chordFor, formatChord, registerShortcut } from '../../lib/shortcuts'
import { KEYS, readLocalBool, writeLocalBool } from '../../lib/localPrefs'
import { toastError } from '../../lib/toast'
import { useStore } from '../../store'
import {
  Button,
  Card,
  ChevronDownIcon,
  ChoiceCard,
  CloseIcon,
  Field,
  GearIcon,
  IconButton,
  Input,
  Kbd,
  LockIcon,
  Modal,
  PencilIcon,
} from '../../ui'
import { AvatarPicker } from './AvatarPicker'
import { CreatorPalette } from './CreatorPalette'
import { GardenGame } from './GardenGame'

function GardenMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 21V9" />
      <path d="M12 13c-4.7 0-7-2.3-7-7 4.7 0 7 2.3 7 7Z" />
      <path d="M12 16c4.7 0 7-2.3 7-7-4.7 0-7 2.3-7 7Z" />
    </svg>
  )
}

function RoomsMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M7 3v6M16 9v6M10 15v6" />
    </svg>
  )
}

function SoundMark({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {on ? <path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" /> : <path d="m16 9 5 6m0-6-5 6" />}
    </svg>
  )
}

function RoomPreview({ variant }: { variant: GardenRoom['room_variant'] }) {
  const largeHouse = variant === 'greenhouse' || variant === 'pond'
  return (
    <span
      className="relative block h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-border bg-[#9dbc40]"
      aria-hidden
    >
      <img
        src="/assets/garden/ninja-adventure/tileset_village.png"
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{
          imageRendering: 'pixelated',
          width: 160,
          height: 96,
          left: largeHouse ? -88 : -128,
          top: -48,
          transform: variant === 'orchard' ? 'scaleX(-1)' : undefined,
        }}
      />
    </span>
  )
}

function TeleportMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 14c-2 1-3 2.2-3 3.5C2 20 6.5 22 12 22s10-2 10-4.5c0-1.3-1.1-2.5-3-3.5" />
    </svg>
  )
}

function MelodyMark({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M9 18V5l10-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="16" cy="16" r="3" />
      {!on && <path d="m3 3 18 18" />}
    </svg>
  )
}

function GardenMinimap({
  map,
  space,
  zenMode,
}: {
  map: GardenMap
  space: 'hub' | 'room'
  zenMode: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = 160
      const height = 112
      canvas.width = width * dpr
      canvas.height = height * dpr
      const context = canvas.getContext('2d')
      if (!context) return
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, width, height)
      context.fillStyle = '#10120f'
      context.fillRect(0, 0, width, height)
      const self = useStore.getState().garden.self

      if (space === 'room' || zenMode) {
        context.strokeStyle = '#8ca875'
        context.lineWidth = 2
        context.strokeRect(12, 12, width - 24, height - 24)
        context.fillStyle = zenMode ? '#b9dc8f' : '#7c6cff'
        const x = 12 + ((zenMode ? 16 : (self?.x ?? 16)) / 32) * (width - 24)
        const y = 12 + ((zenMode ? 19 : (self?.y ?? 19)) / 24) * (height - 24)
        context.beginPath()
        context.arc(x, y, 3.5, 0, Math.PI * 2)
        context.fill()
        return
      }

      const maxY = Math.max(96, map.temple.y + 12, ...map.rooms.map((room) => room.door_y + 8))
      const sx = (x: number) => 7 + (x / 104) * (width - 14)
      const sy = (y: number) => 7 + (y / maxY) * (height - 14)
      context.strokeStyle = '#6c7d50'
      context.lineWidth = 1.4
      context.beginPath()
      for (const room of map.rooms) {
        context.moveTo(sx(52), sy(64))
        context.lineTo(sx(room.door_x), sy(64))
        context.lineTo(sx(room.door_x), sy(room.door_y))
      }
      context.moveTo(sx(52), sy(64))
      context.lineTo(sx(map.temple.x), sy(map.temple.y))
      context.stroke()
      context.fillStyle = '#d3ad45'
      for (const room of map.rooms) {
        context.fillRect(sx(room.door_x) - 2, sy(room.door_y) - 2, 4, 4)
      }
      context.fillStyle = '#a9cf7c'
      context.beginPath()
      context.moveTo(sx(map.temple.x), sy(map.temple.y) - 4)
      context.lineTo(sx(map.temple.x) - 4, sy(map.temple.y) + 3)
      context.lineTo(sx(map.temple.x) + 4, sy(map.temple.y) + 3)
      context.closePath()
      context.fill()
      // Other people in the hub, each in their join-order colour — the same
      // colour as their ring in-world, so the two readings agree.
      const peers = useStore.getState().garden.peers
      for (const peer of Object.values(peers)) {
        if (peer.space !== 'hub') continue
        context.fillStyle = gardenColor(peer.color_index).hex
        context.beginPath()
        context.arc(sx(peer.x), sy(peer.y), 2.5, 0, Math.PI * 2)
        context.fill()
      }
      // Self last so it is never hidden under a peer, and ringed so it reads as
      // "you" even when someone else holds the same slot.
      context.fillStyle = gardenColor(self?.color_index).hex
      context.beginPath()
      context.arc(sx(self?.x ?? map.spawn.x), sy(self?.y ?? map.spawn.y), 3.5, 0, Math.PI * 2)
      context.fill()
      context.strokeStyle = 'rgba(255,255,255,0.9)'
      context.lineWidth = 1.25
      context.stroke()
    }
    draw()
    const unsubscribe = useStore.subscribe(draw)
    const observer = new ResizeObserver(draw)
    if (canvasRef.current) observer.observe(canvasRef.current)
    return () => {
      unsubscribe()
      observer.disconnect()
    }
  }, [map, space, zenMode])

  return (
    <div
      className="pointer-events-none absolute bottom-24 right-2 z-(--z-dropdown) origin-bottom-right scale-75 overflow-hidden rounded-xl border border-white/12 bg-[#10120f] shadow-2xl sm:bottom-4 sm:right-4 sm:scale-100"
      aria-label="Garden minimap"
    >
      <canvas ref={canvasRef} className="block h-28 w-40" />
      <span className="absolute left-2 top-1.5 text-[9px] font-bold tracking-[0.18em] text-white/55">
        MAP
      </span>
    </div>
  )
}

function RoomList({
  rooms,
  currentId,
  teleportingId,
  onTeleport,
  onTemple,
}: {
  rooms: GardenRoom[]
  currentId: string | null
  teleportingId: string | null
  onTeleport: (room: GardenRoom) => void
  onTemple: () => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      <button
        type="button"
        disabled={teleportingId !== null}
        onClick={onTemple}
        className="group mb-1 flex min-h-16 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-[#293025] focus-visible:ring-2 focus-visible:ring-[#a8c983] disabled:cursor-default disabled:opacity-55"
      >
        <span className="flex h-12 w-12 shrink-0 items-end justify-center overflow-hidden rounded-lg bg-[#1d241a]">
          <img
            src="/assets/garden/feudal-japan/wooden_gate.png"
            alt=""
            className="h-12 w-12 object-contain"
            style={{ imageRendering: 'pixelated' }}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-[var(--color-text)]">
            Zen temple
          </span>
          <span className="block truncate text-xs text-[var(--color-text-faint)]">
            DnD · calm melody
          </span>
        </span>
        <span className="text-xs font-semibold text-[#a8c983] opacity-70 transition-opacity group-hover:opacity-100">
          {teleportingId === 'temple' ? 'Flying…' : 'Travel'}
        </span>
      </button>
      {rooms.map((room) => {
        const current = room.channel_id === currentId
        return (
          <button
            key={room.channel_id}
            type="button"
            disabled={current || teleportingId !== null}
            onClick={() => onTeleport(room)}
            className="group flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default disabled:opacity-55"
          >
            <RoomPreview variant={room.room_variant} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--color-text)]">
                {room.name}
                {room.kind === 'private' && (
                  <span className="inline-flex items-center gap-1 text-text-faint">
                    <LockIcon />
                    <span className="sr-only">Private</span>
                  </span>
                )}
              </span>
              <span className="block truncate text-xs text-[var(--color-text-faint)]">
                {room.occupancy > 0 ? `${room.occupancy} inside` : 'Quiet now'}
                {!room.is_member && ' · joins on arrival'}
              </span>
            </span>
            <span className="flex items-center gap-1 text-xs font-semibold text-[var(--color-accent-hover)] opacity-70 transition-opacity group-hover:opacity-100">
              <TeleportMark />
              <span className="hidden xl:inline">
                {teleportingId === room.channel_id ? 'Flying…' : current ? 'Here' : 'Teleport'}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function CreateGardenRoomModal({ onClose }: { onClose: () => void }) {
  const createChannel = useStore((state) => state.createChannel)
  const loadGarden = useStore((state) => state.loadGarden)
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [busy, setBusy] = useState(false)
  const normalized = name.trim().toLowerCase()
  const valid = /^[a-z0-9-]{1,50}$/.test(normalized)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    try {
      await createChannel({
        name: normalized,
        kind,
        topic: topic.trim() || undefined,
      })
      await loadGarden()
      sound.garden.roomCreate()
      onClose()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not create the room.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create a Garden room" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Room name" hint="Lowercase letters, numbers, and hyphens.">
          <Input
            autoFocus
            prefix="#"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="quiet-design"
          />
        </Field>
        <Field label="What happens here? (optional)">
          <Input
            value={topic}
            onChange={(event) => setTopic(event.target.value)}
            placeholder="Weekly critique and co-working"
          />
        </Field>
        <div className="flex gap-2">
          <ChoiceCard
            selected={kind === 'public'}
            onSelect={() => setKind('public')}
            title="Public"
            description="Anyone can visit"
            selectedStyle="fill"
            className="flex-1"
          />
          <ChoiceCard
            selected={kind === 'private'}
            onSelect={() => setKind('private')}
            title="Private"
            description="Members only"
            selectedStyle="fill"
            className="flex-1"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || busy}>
            {busy ? 'Planting…' : 'Create room'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function GardenView() {
  // Do not subscribe React chrome to 10 Hz peer movement. Phaser reads the
  // high-frequency slice directly; these selectors change only on UI-level events.
  const map = useStore((state) => state.garden.map)
  const status = useStore((state) => state.garden.status)
  const space = useStore((state) => state.garden.space)
  const channelId = useStore((state) => state.garden.channelId)
  const audioMode = useStore((state) => state.garden.audioMode)
  const error = useStore((state) => state.garden.error)
  const peerCount = useStore((state) => Object.keys(state.garden.peers).length)
  const enterGarden = useStore((state) => state.enterGarden)
  const leaveGarden = useStore((state) => state.leaveGarden)
  const enterRoom = useStore((state) => state.enterGardenRoom)
  const exitRoom = useStore((state) => state.exitGardenRoom)
  const setZenPresence = useStore((state) => state.setGardenZen)
  const setAudio = useStore((state) => state.setGardenAudio)
  const selfAvatar = useStore((state) => state.garden.selfAvatar)
  const canEdit = useStore((state) => state.garden.canEdit)
  const layoutCount = useStore((state) => state.garden.layout.length)
  const setGardenAvatar = useStore((state) => state.setGardenAvatar)
  const dnd = useStore((state) => state.dnd)
  const setDnd = useStore((state) => state.setDnd)
  const [nearby, setNearby] = useState<GardenRoom | null>(null)
  const [nearbyTemple, setNearbyTemple] = useState(false)
  const [roomsOpen, setRoomsOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [teleportingId, setTeleportingId] = useState<string | null>(null)
  const [zenMode, setZenMode] = useState(false)
  const [melodyEnabled, setMelodyEnabled] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem('sharp.garden.zen-melody') !== 'off'
  })
  const [melodyVolume, setMelodyVolume] = useState(() => {
    if (typeof window === 'undefined') return 0.34
    const stored = window.localStorage.getItem('sharp.garden.zen-volume')
    if (stored === null) return 0.34
    const parsed = Number(stored)
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0.34
  })
  const melodyRef = useRef<HTMLAudioElement | null>(null)
  const zenDndBeforeRef = useRef<boolean | null>(null)
  const zenModeRef = useRef(false)

  // Room rail: collapsed by default so the map is the page. Hovering the header
  // card peeks the panel; the chevron pins it open. Same three-state shape as the
  // auto-hide dock in AppShell — a plain boolean cannot express "peeking".
  const [railPinned, setRailPinned] = useState(() =>
    readLocalBool(KEYS.gardenRailPinned, false),
  )
  const [railPeeking, setRailPeeking] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  // Creator mode follows the zenMode pattern in this file: local state plus a ref
  // mirror for the Phaser side plus broad render gating.
  const [creatorMode, setCreatorMode] = useState(false)
  const [brush, setBrush] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const creatorModeRef = useRef(false)
  creatorModeRef.current = creatorMode
  const railHideTimer = useRef<number | null>(null)
  const railOpen = railPinned || railPeeking

  const showRail = () => {
    if (railHideTimer.current !== null) {
      window.clearTimeout(railHideTimer.current)
      railHideTimer.current = null
    }
    setRailPeeking(true)
  }
  // Enough slack to cross the gap between the header card and the panel without
  // the panel collapsing under the cursor.
  const scheduleHideRail = () => {
    if (railHideTimer.current !== null) window.clearTimeout(railHideTimer.current)
    railHideTimer.current = window.setTimeout(() => {
      railHideTimer.current = null
      setRailPeeking(false)
    }, 150)
  }
  const toggleRailPin = () => {
    sound.garden.interact()
    setRailPinned((pinned) => {
      const next = !pinned
      writeLocalBool(KEYS.gardenRailPinned, next)
      if (!next) setRailPeeking(false)
      return next
    })
  }

  useEffect(
    () => () => {
      if (railHideTimer.current !== null) window.clearTimeout(railHideTimer.current)
    },
    [],
  )

  // Offer the character picker once per device to someone who has never chosen.
  // Non-blocking on purpose: skipping keeps the deterministic fallback, which
  // already looks correct to everyone else.
  //
  // The decision reads map.self_avatar, not the store mirror: the mirror starts
  // as null and is only filled once the map response lands, so keying off it
  // popped the picker at someone who already had a character.
  // undefined = the map has not loaded yet, which is NOT the same as "never
  // picked". Conflating the two is what popped the picker at existing users.
  const serverAvatar = map ? (map.self_avatar ?? null) : undefined
  useEffect(() => {
    if (serverAvatar === undefined || serverAvatar !== null) return
    if (readLocalBool(KEYS.gardenAvatarPrompted, false)) return
    setAvatarOpen(true)
  }, [serverAvatar])

  useEffect(() => {
    void enterGarden()
    return () => {
      melodyRef.current?.pause()
      if (zenModeRef.current) {
        setZenPresence(false)
        if (zenDndBeforeRef.current === false) void setDnd(false)
      }
      leaveGarden()
    }
  }, [enterGarden, leaveGarden, setDnd, setZenPresence])

  useEffect(() => {
    const off = [
      registerShortcut('garden.enter-room', (event) => {
        if (
          roomsOpen ||
          createOpen ||
          document.querySelector('[role="dialog"]')
        ) {
          return
        }
        if (zenMode) return
        if (nearbyTemple && space === 'hub') {
          event.preventDefault()
          enterZenMode()
          return
        }
        if (space !== 'hub' || !nearby) return
        event.preventDefault()
        sound.garden.interact()
        void enterRoom(nearby.channel_id)
      }),
      registerShortcut('garden.exit-room', (event) => {
        if (document.querySelector('[role="dialog"]')) return
        // Creator mode owns Escape before it means "leave the room".
        if (creatorModeRef.current) {
          event.preventDefault()
          setCreatorMode(false)
          setBrush(null)
          return
        }
        if (zenMode) {
          event.preventDefault()
          exitZenMode()
          return
        }
        if (roomsOpen) {
          event.preventDefault()
          setRoomsOpen(false)
          return
        }
        // Collapse the desktop rail before Escape means "leave the room".
        if (railPinned || railPeeking) {
          event.preventDefault()
          setRailPeeking(false)
          if (railPinned) {
            setRailPinned(false)
            writeLocalBool(KEYS.gardenRailPinned, false)
          }
          return
        }
        // Let the consent modal own Escape while it is open.
        if (space !== 'room' || audioMode === 'ask') return
        event.preventDefault()
        sound.voiceLeave()
        exitRoom()
      }),
      registerShortcut('garden.create-room', (event) => {
        if (
          createOpen ||
          roomsOpen ||
          zenMode ||
          document.querySelector('[role="dialog"]')
        ) {
          return
        }
        event.preventDefault()
        sound.garden.interact()
        setCreateOpen(true)
      }),
    ]
    return () => off.forEach((unregister) => unregister())
  })

  const currentRoom = useMemo(
    () => map?.rooms.find((room) => room.channel_id === channelId) ?? null,
    [channelId, map],
  )

  useEffect(() => {
    if (
      teleportingId &&
      space === 'room' &&
      channelId === teleportingId
    ) {
      const timeout = window.setTimeout(() => setTeleportingId(null), 700)
      return () => window.clearTimeout(timeout)
    }
  }, [channelId, space, teleportingId])

  useEffect(() => {
    if (error && teleportingId) setTeleportingId(null)
  }, [error, teleportingId])

  useEffect(() => {
    if (melodyRef.current) melodyRef.current.volume = melodyVolume
    window.localStorage.setItem('sharp.garden.zen-volume', String(melodyVolume))
  }, [melodyVolume])

  function teleportTo(room: GardenRoom) {
    if (teleportingId || room.channel_id === channelId) return
    setTeleportingId(room.channel_id)
    setRoomsOpen(false)
    window.dispatchEvent(new CustomEvent('sharp:garden-teleport', { detail: room }))
  }

  function walkToTemple() {
    if (teleportingId) return
    setTeleportingId('temple')
    setRoomsOpen(false)
    sound.garden.interact()
    window.dispatchEvent(new Event('sharp:garden-teleport-temple'))
    window.setTimeout(() => setTeleportingId((current) => current === 'temple' ? null : current), 1600)
  }

  function ensureMelody() {
    if (!melodyRef.current) {
      const melody = new Audio('/assets/garden/audio/dark-shrine-loop.ogg')
      melody.loop = true
      melody.preload = 'auto'
      melodyRef.current = melody
    }
    melodyRef.current.volume = melodyVolume
    return melodyRef.current
  }

  function enterZenMode() {
    if (zenMode) return
    zenDndBeforeRef.current = dnd
    zenModeRef.current = true
    setZenMode(true)
    setZenPresence(true)
    if (!dnd) void setDnd(true)
    sound.garden.zen()
    if (melodyEnabled) void ensureMelody().play().catch(() => {})
  }

  function exitZenMode() {
    if (!zenModeRef.current) return
    melodyRef.current?.pause()
    zenModeRef.current = false
    setZenMode(false)
    setZenPresence(false)
    if (zenDndBeforeRef.current === false) void setDnd(false)
    zenDndBeforeRef.current = null
    sound.garden.interact()
  }

  function toggleMelody() {
    const next = !melodyEnabled
    setMelodyEnabled(next)
    window.localStorage.setItem('sharp.garden.zen-melody', next ? 'on' : 'off')
    if (next && zenMode) void ensureMelody().play().catch(() => {})
    else melodyRef.current?.pause()
  }

  if (!map && status !== 'error') {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-ink text-text-dim">
        <div className="flex items-center gap-3 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
          Opening Garden…
        </div>
      </main>
    )
  }

  if (!map) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-bg)] p-6">
        <div className="max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
            <GardenMark />
          </div>
          <h1 className="text-lg font-semibold text-[var(--color-text)]">Garden is resting</h1>
          <p className="mt-1 text-sm text-[var(--color-text-dim)]">{error}</p>
          <Button className="mt-4" onClick={() => void enterGarden()}>Try again</Button>
        </div>
      </main>
    )
  }

  return (
    <main className="relative min-h-0 flex-1 overflow-hidden bg-ink">
      <GardenGame
        map={map}
        space={space}
        channelId={channelId}
        zenMode={zenMode}
        onNearbyRoom={setNearby}
        onNearbyTemple={setNearbyTemple}
        editing={creatorMode}
        brush={brush}
        onSelection={setSelection}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-(--z-dropdown) flex items-start justify-between gap-3 p-3 sm:p-4">
        <Card
          padding="sm"
          className="pointer-events-auto flex min-w-0 items-center gap-3 shadow-xl lg:w-72"
          onMouseEnter={zenMode ? undefined : showRail}
          onMouseLeave={zenMode ? undefined : scheduleHideRail}
          onFocusCapture={zenMode ? undefined : showRail}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-ink">
            <GardenMark size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-text">
              {zenMode ? 'Zen temple' : (currentRoom?.name ?? 'Garden')}
            </h1>
            <p className="truncate text-2xs text-text-faint">
              {zenMode
                ? 'Notifications paused · your status is visible'
                : space === 'room'
                ? `${peerCount + 1} here · camera off`
                : `${map.rooms.length} connected rooms · Space to jump`}
            </p>
          </div>
          {!zenMode && (
            <span className="hidden lg:block">
              <IconButton
                label={railPinned ? 'Unpin room list' : 'Keep room list open'}
                shape="circle"
                aria-expanded={railOpen}
                aria-controls="garden-room-rail"
                onClick={toggleRailPin}
              >
                <ChevronDownIcon
                  className={`transition-transform motion-reduce:transition-none ${
                    railOpen ? 'rotate-180' : ''
                  }`}
                />
              </IconButton>
            </span>
          )}
        </Card>
        <Card padding="none" className="pointer-events-auto flex items-center gap-1 p-1.5 shadow-xl">
          <IconButton
            label={audioMode === 'on' ? 'Turn Garden audio off' : 'Turn Garden audio on'}
            shape="circle"
            onClick={() => {
              sound.garden.interact()
              setAudio(audioMode === 'on' ? 'off' : 'on')
            }}
          >
            <SoundMark on={audioMode === 'on'} />
          </IconButton>
          {!zenMode && canEdit && (
            <IconButton
              label={creatorMode ? 'Leave creator mode' : 'Edit the Garden'}
              shape="circle"
              onClick={() => {
                sound.garden.interact()
                setCreatorMode((on) => !on)
                setBrush(null)
              }}
            >
              <PencilIcon />
            </IconButton>
          )}
          {!zenMode && (
            <IconButton
              label="Change your character"
              shape="circle"
              onClick={() => {
                sound.garden.interact()
                setAvatarOpen(true)
              }}
            >
              <GearIcon />
            </IconButton>
          )}
          {!zenMode && (
            <span className="lg:hidden">
              <IconButton
                label="Browse Garden rooms"
                shape="circle"
                onClick={() => {
                  sound.garden.interact()
                  setRoomsOpen((open) => !open)
                }}
              >
                <RoomsMark />
              </IconButton>
            </span>
          )}
        </Card>
      </header>

      {error && (
        <div
          role="status"
          className="absolute left-1/2 top-20 z-(--z-slideover) w-[min(92vw,28rem)] -translate-x-1/2 rounded-lg border border-[var(--color-danger-fg)]/30 bg-[var(--color-panel)] px-4 py-3 text-center text-sm text-[var(--color-text)] shadow-xl"
        >
          {error}
        </div>
      )}

      {!zenMode && !creatorMode && (
        <aside
          id="garden-room-rail"
          data-shown={railOpen}
          aria-hidden={!railOpen}
          onMouseEnter={showRail}
          onMouseLeave={scheduleHideRail}
          className="garden-rail-float absolute left-3 top-[4.6rem] z-(--z-dropdown) hidden max-h-[min(30rem,calc(100dvh-8rem))] w-72 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/96 shadow-2xl backdrop-blur sm:left-4 lg:flex"
        >
          <div className="border-b border-[var(--color-border)] px-4 py-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Garden rooms</h2>
              <Kbd>{formatChord(chordFor('garden.create-room'))}</Kbd>
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
              Hover a room to teleport.
            </p>
          </div>
          <RoomList
            rooms={map.rooms}
            currentId={channelId}
            teleportingId={teleportingId}
            onTeleport={teleportTo}
            onTemple={walkToTemple}
          />
          <div className="border-t border-[var(--color-border)] p-2">
            <Button
              variant="ghost"
              className="w-full justify-center"
              onClick={() => setCreateOpen(true)}
            >
              Create room
              <Kbd>{formatChord(chordFor('garden.create-room'))}</Kbd>
            </Button>
          </div>
        </aside>
      )}

      {roomsOpen && !zenMode && (
        <aside className="absolute bottom-3 right-3 top-20 z-(--z-slideover) flex w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl sm:bottom-4 sm:right-4 lg:hidden">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Garden rooms</h2>
              <p className="text-xs text-[var(--color-text-faint)]">Tap a room to teleport.</p>
            </div>
            <IconButton label="Close room list" onClick={() => setRoomsOpen(false)}>
              <CloseIcon />
            </IconButton>
          </div>
          <RoomList
            rooms={map.rooms}
            currentId={channelId}
            teleportingId={teleportingId}
            onTeleport={teleportTo}
            onTemple={walkToTemple}
          />
          <div className="border-t border-[var(--color-border)] p-2">
            <Button
              variant="ghost"
              className="w-full justify-center"
              onClick={() => {
                setRoomsOpen(false)
                setCreateOpen(true)
              }}
            >
              Create room
              <Kbd>{formatChord(chordFor('garden.create-room'))}</Kbd>
            </Button>
          </div>
        </aside>
      )}

      {zenMode && (
        <aside className="absolute right-4 top-24 z-(--z-dropdown) w-[min(18rem,calc(100%-2rem))] rounded-xl border border-white/12 bg-[#171914]/96 p-3 text-white shadow-2xl backdrop-blur">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#a8c983] text-[#171914]">
              <MelodyMark on={melodyEnabled} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Zen mode</p>
              <p className="text-xs text-white/58">DnD is on until you leave.</p>
            </div>
            <button
              type="button"
              aria-pressed={melodyEnabled}
              onClick={toggleMelody}
              className="min-h-10 rounded-lg border border-white/12 px-3 text-xs font-semibold text-white transition-colors hover:bg-white/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#a8c983]"
            >
              {melodyEnabled ? 'Melody on' : 'Melody off'}
            </button>
          </div>
          <label className="mt-3 flex items-center gap-3 text-xs text-white/65">
            <span>Volume</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={melodyVolume}
              disabled={!melodyEnabled}
              onChange={(event) => setMelodyVolume(Number(event.target.value))}
              className="min-h-10 flex-1 accent-[#a8c983] disabled:opacity-35"
            />
            <span className="w-8 text-right tabular-nums">{Math.round(melodyVolume * 100)}</span>
          </label>
        </aside>
      )}

      <GardenMinimap map={map} space={space} zenMode={zenMode} />

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-(--z-dropdown) flex justify-center px-4">
        {zenMode ? (
          <Button
            variant="outline"
            size="lg"
            className="pointer-events-auto border-white/14 bg-[#171914] text-white shadow-xl hover:bg-[#23261f]"
            onClick={exitZenMode}
          >
            Leave Zen mode
            <Kbd>{formatChord(chordFor('garden.exit-room'))}</Kbd>
          </Button>
        ) : space === 'room' ? (
          <Button
            variant="outline"
            size="lg"
            className="pointer-events-auto bg-panel shadow-xl"
            onClick={() => {
              sound.voiceLeave()
              exitRoom()
            }}
          >
            Leave room
            <Kbd>{formatChord(chordFor('garden.exit-room'))}</Kbd>
          </Button>
        ) : nearbyTemple ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-white/12 bg-[#171914] p-2 pl-3 text-white shadow-2xl">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Zen temple</p>
              <p className="text-xs text-white/58">
                Pause notifications
                {' · '}
                <Kbd>{formatChord(chordFor('garden.enter-room'))}</Kbd>
              </p>
            </div>
            <Button size="sm" onClick={enterZenMode}>Enter Zen mode</Button>
          </div>
        ) : nearby ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 pl-3 shadow-2xl">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--color-text)]">{nearby.name}</p>
              <p className="text-xs text-[var(--color-text-faint)]">
                {nearby.is_member ? 'Enter room' : 'Public group · join and enter'}
                {' · '}
                <Kbd>{formatChord(chordFor('garden.enter-room'))}</Kbd>
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                sound.garden.interact()
                void enterRoom(nearby.channel_id)
              }}
            >
              {nearby.is_member ? 'Enter' : 'Join + enter'}
            </Button>
          </div>
        ) : (
          <div className="pointer-events-auto flex items-center gap-4 rounded-xl border border-white/12 bg-[#171914]/94 px-4 py-3 text-sm text-white shadow-xl backdrop-blur">
            <span className="flex items-center gap-2">
              <Kbd>{formatChord(chordFor('garden.create-room'))}</Kbd>
              Create room
            </span>
            <span className="h-4 w-px bg-white/14" />
            <span className="hidden items-center gap-2 text-white/55 sm:flex">
              <Kbd>Space</Kbd>
              Jump
            </span>
          </div>
        )}
      </div>

      {creatorMode && !zenMode && (
        <CreatorPalette
          brush={brush}
          onBrush={setBrush}
          selection={selection}
          count={layoutCount}
          onDelete={() => window.dispatchEvent(new CustomEvent('sharp:garden-delete'))}
          onExit={() => {
            setCreatorMode(false)
            setBrush(null)
          }}
        />
      )}

      {createOpen && <CreateGardenRoomModal onClose={() => setCreateOpen(false)} />}

      {avatarOpen && (
        <AvatarPicker
          value={selfAvatar ?? serverAvatar ?? null}
          allowed={map.avatars}
          onClose={() => {
            // Record the offer either way, so a skip is not re-asked next visit.
            writeLocalBool(KEYS.gardenAvatarPrompted, true)
            setAvatarOpen(false)
          }}
          onChoose={(avatar) => {
            writeLocalBool(KEYS.gardenAvatarPrompted, true)
            setGardenAvatar(avatar)
            setAvatarOpen(false)
          }}
        />
      )}

      {audioMode === 'ask' && space === 'room' && (
        <Modal
          title="Hear rooms as you enter?"
          onClose={() => setAudio('off')}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAudio('off')}>Not now</Button>
              <Button onClick={() => setAudio('on')}>Turn on room audio</Button>
            </>
          }
        >
          <p className="text-sm text-[var(--color-text-dim)]">
            Garden can join each room’s audio automatically. Your mic follows your call settings,
            your camera stays off, and an existing call is never replaced. Change this any time
            with the speaker button in Garden.
          </p>
        </Modal>
      )}
    </main>
  )
}
