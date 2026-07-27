import { useEffect, useMemo, useState } from 'react'
import type { GardenRoom } from '../../lib/types'
import { useStore } from '../../store'
import { Button, IconButton, Modal } from '../../ui'
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
  const setAudio = useStore((state) => state.setGardenAudio)
  const [nearby, setNearby] = useState<GardenRoom | null>(null)
  const [roomsOpen, setRoomsOpen] = useState(false)
  const [walkingTo, setWalkingTo] = useState<string | null>(null)

  useEffect(() => {
    void enterGarden()
    return () => leaveGarden()
  }, [enterGarden, leaveGarden])

  const currentRoom = useMemo(
    () => map?.rooms.find((room) => room.channel_id === channelId) ?? null,
    [channelId, map],
  )

  function guideTo(room: GardenRoom) {
    setWalkingTo(room.channel_id)
    setRoomsOpen(false)
    window.dispatchEvent(new CustomEvent('sharp:garden-walk-to', { detail: room }))
  }

  if (!map && status !== 'error') {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center bg-[var(--color-ink)] text-[var(--color-text-dim)]">
        <div className="flex items-center gap-3 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
          Planting the paths…
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
    <main className="relative min-h-0 flex-1 overflow-hidden bg-[var(--color-ink)]">
      <GardenGame
        map={map}
        space={space}
        channelId={channelId}
        onNearbyRoom={(room) => {
          setNearby(room)
          if (room) setWalkingTo(null)
        }}
      />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-(--z-dropdown) flex items-start justify-between gap-3 p-3 sm:p-4">
        <div className="pointer-events-auto flex min-w-0 items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] px-3 py-2 text-white shadow-lg backdrop-blur-md">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white">
            <GardenMark size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">
              {currentRoom?.name ?? 'Garden'}
            </h1>
            <p className="truncate text-2xs text-white/65">
              {space === 'room'
                ? `${peerCount + 1} here · camera off`
                : `${map.rooms.length} paths · arrows, WASD, or tap`}
            </p>
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-ink)_88%,transparent)] p-1.5 shadow-lg backdrop-blur-md">
          <IconButton
            label={audioMode === 'on' ? 'Turn Garden audio off' : 'Turn Garden audio on'}
            shape="circle"
            className="text-white/75 hover:bg-white/10 hover:text-white"
            onClick={() => setAudio(audioMode === 'on' ? 'off' : 'on')}
          >
            <SoundMark on={audioMode === 'on'} />
          </IconButton>
          <IconButton
            label="Browse Garden rooms"
            shape="circle"
            className="text-white/75 hover:bg-white/10 hover:text-white"
            onClick={() => setRoomsOpen((open) => !open)}
          >
            <RoomsMark />
          </IconButton>
        </div>
      </header>

      {error && (
        <div
          role="status"
          className="absolute left-1/2 top-20 z-(--z-slideover) w-[min(92vw,28rem)] -translate-x-1/2 rounded-lg border border-[var(--color-danger-fg)]/30 bg-[var(--color-panel)] px-4 py-3 text-center text-sm text-[var(--color-text)] shadow-xl"
        >
          {error}
        </div>
      )}

      {roomsOpen && (
        <aside className="absolute bottom-3 right-3 top-20 z-(--z-slideover) flex w-[min(22rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl sm:bottom-4 sm:right-4">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Garden rooms</h2>
              <p className="text-xs text-[var(--color-text-faint)]">Private rooms appear only to members.</p>
            </div>
            <IconButton label="Close room list" onClick={() => setRoomsOpen(false)}>
              <span aria-hidden>×</span>
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {map.rooms.map((room) => (
              <button
                key={room.channel_id}
                type="button"
                onClick={() => {
                  if (space === 'room' && room.channel_id === channelId) {
                    setRoomsOpen(false)
                  } else if (space === 'hub') {
                    guideTo(room)
                  }
                }}
                className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)] text-xs font-bold uppercase text-[var(--color-accent-hover)]">
                  {room.room_variant.slice(0, 2)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium text-[var(--color-text)]">
                    {room.name}
                    {room.kind === 'private' && <span aria-label="Private">· locked</span>}
                  </span>
                  <span className="text-xs text-[var(--color-text-faint)]">
                    {room.occupancy > 0 ? `${room.occupancy} inside` : 'Quiet now'}
                    {!room.is_member && ' · join at the door'}
                  </span>
                </span>
                <span className="text-xs font-semibold text-[var(--color-accent-hover)]">
                  {walkingTo === room.channel_id ? 'Walking…' : 'Guide'}
                </span>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-(--z-dropdown) flex justify-center px-4">
        {space === 'room' ? (
          <Button
            variant="outline"
            size="lg"
            className="pointer-events-auto border-white/25 bg-[color-mix(in_srgb,var(--color-ink)_90%,transparent)] text-white hover:bg-[var(--color-ink)] hover:text-white"
            onClick={exitRoom}
          >
            Leave room
          </Button>
        ) : nearby ? (
          <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 pl-3 shadow-2xl">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[var(--color-text)]">{nearby.name}</p>
              <p className="text-xs text-[var(--color-text-faint)]">
                {nearby.is_member ? 'Enter room' : 'Public group · join and enter'}
              </p>
            </div>
            <Button size="sm" onClick={() => void enterRoom(nearby.channel_id)}>
              {nearby.is_member ? 'Enter' : 'Join + enter'}
            </Button>
          </div>
        ) : (
          <div className="rounded-lg bg-[color-mix(in_srgb,var(--color-ink)_82%,transparent)] px-3 py-2 text-xs text-white/70 backdrop-blur-sm">
            Follow a path to a doorway
          </div>
        )}
      </div>

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
