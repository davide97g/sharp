import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type VoiceStageMode } from '../../store'
import { channelLabel } from '../../lib/util'
import { Avatar } from '../Avatar'
import { VoiceMiniWidget } from './VoiceMiniWidget'

type StageParticipant = {
  userId: string
  connIds: string[]
  muted: boolean
  speaking: boolean
  cameraConnId: string | null
}

type MediaDeviceOption = {
  deviceId: string
  label: string
}

const STAGE_SIZE: Record<
  Exclude<VoiceStageMode, 'mini'>,
  { width: string; height: string; minWidth: number; minHeight: number }
> = {
  expanded: {
    width: 'min(920px, calc(100vw - 2rem))',
    height: 'min(640px, calc(100vh - 2rem))',
    minWidth: 480,
    minHeight: 360,
  },
  compact: {
    width: 'min(420px, calc(100vw - 2rem))',
    height: 'min(320px, calc(100vh - 2rem))',
    minWidth: 280,
    minHeight: 220,
  },
}

export function VideoStage() {
  const channelId = useStore((s) => s.voice.channelId)
  const stageMode = useStore((s) => s.voice.stageMode)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const speaking = useStore((s) => s.voice.speaking)
  const muted = useStore((s) => s.voice.muted)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const audioDeviceId = useStore((s) => s.voice.audioDeviceId)
  const videoDeviceId = useStore((s) => s.voice.videoDeviceId)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const myConnId = useStore((s) => s.myConnId)
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channel = useStore((s) => s.channels.find((candidate) => candidate.id === channelId))
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const setVoiceAudioDevice = useStore((s) => s.setVoiceAudioDevice)
  const setVoiceVideoDevice = useStore((s) => s.setVoiceVideoDevice)
  const setVoiceStageMode = useStore((s) => s.setVoiceStageMode)
  const leaveVoice = useStore((s) => s.leaveVoice)
  const [mics, setMics] = useState<MediaDeviceOption[]>([])
  const [cameras, setCameras] = useState<MediaDeviceOption[]>([])
  const panelRef = useRef<HTMLElement>(null)
  const dragRef = useRef<{
    pointerId: number
    originX: number
    originY: number
    startLeft: number
    startTop: number
  } | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function refreshDevices() {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        if (cancelled) return
        setMics(
          devices
            .filter((device) => device.kind === 'audioinput')
            .map((device, index) => ({
              deviceId: device.deviceId,
              label: device.label || `Microphone ${index + 1}`,
            })),
        )
        setCameras(
          devices
            .filter((device) => device.kind === 'videoinput')
            .map((device, index) => ({
              deviceId: device.deviceId,
              label: device.label || `Camera ${index + 1}`,
            })),
        )
      } catch {
        if (!cancelled) {
          setMics([])
          setCameras([])
        }
      }
    }

    void refreshDevices()
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
    return () => {
      cancelled = true
      navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
    }
  }, [])

  useEffect(() => {
    setPosition(null)
  }, [stageMode])

  useEffect(() => {
    function onResize() {
      setPosition((current) => {
        const panel = panelRef.current
        if (!current || !panel) return current
        return {
          left: Math.min(
            Math.max(8, current.left),
            Math.max(8, window.innerWidth - panel.offsetWidth - 8),
          ),
          top: Math.min(
            Math.max(8, current.top),
            Math.max(8, window.innerHeight - panel.offsetHeight - 8),
          ),
        }
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const participants = useMemo(() => {
    const byUser = new Map<string, StageParticipant>()
    for (const [connId, entry] of Object.entries(room ?? {})) {
      const existing = byUser.get(entry.user_id)
      if (existing) {
        existing.connIds.push(connId)
        existing.muted = existing.muted && entry.muted
        existing.speaking = existing.speaking || Boolean(speaking[connId])
        if (entry.camera_on && (!existing.cameraConnId || connId === myConnId)) {
          existing.cameraConnId = connId
        }
      } else {
        byUser.set(entry.user_id, {
          userId: entry.user_id,
          connIds: [connId],
          muted: entry.muted,
          speaking: Boolean(speaking[connId]),
          cameraConnId: entry.camera_on ? connId : null,
        })
      }
    }
    return [...byUser.values()]
  }, [myConnId, room, speaking])

  if (!channelId) return null
  if (stageMode === 'mini') return <VoiceMiniWidget />

  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Call'
  const anyCamera = participants.some((p) => p.cameraConnId)
  const size = STAGE_SIZE[stageMode]
  const avatarSize = stageMode === 'expanded' ? 88 : 56

  const onHeaderPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button')) return
    const panel = panelRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    }
    setPosition({ left: rect.left, top: rect.top })
    setDragging(true)
  }

  const onHeaderPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const panel = panelRef.current
    if (!panel) return
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const left = Math.min(
      Math.max(8, drag.startLeft + (event.clientX - drag.originX)),
      window.innerWidth - width - 8,
    )
    const top = Math.min(
      Math.max(8, drag.startTop + (event.clientY - drag.originY)),
      window.innerHeight - height - 8,
    )
    setPosition({ left, top })
  }

  const onHeaderPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
  }

  return (
    <section
      ref={panelRef}
      aria-label={`${roomName} huddle`}
      className={`fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-ink)] shadow-2xl ${
        dragging ? '' : 'transition-[width,height] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={{
        width: size.width,
        height: size.height,
        minWidth: size.minWidth,
        minHeight: size.minHeight,
        resize: 'both',
        ...(position
          ? { left: position.left, top: position.top }
          : { right: 16, bottom: 16 }),
      }}
    >
      <header
        className={`flex h-11 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3 ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{roomName}</div>
          <div className="text-[11px] text-[var(--color-text-faint)]">
            {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
          </div>
        </div>
        <button
          type="button"
          aria-label={stageMode === 'expanded' ? 'Reduce call window' : 'Expand call window'}
          title={stageMode === 'expanded' ? 'Reduce' : 'Expand'}
          onClick={() => setVoiceStageMode(stageMode === 'expanded' ? 'compact' : 'expanded')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {stageMode === 'expanded' ? <ReduceIcon /> : <ExpandIcon />}
        </button>
        <button
          type="button"
          aria-label="Minimize call"
          title="Minimize"
          onClick={() => setVoiceStageMode('mini')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <MinimizeIcon />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {anyCamera ? (
          <div
            className={`mx-auto grid h-full auto-rows-fr gap-2 ${
              stageMode === 'expanded'
                ? 'max-w-6xl grid-cols-1 sm:grid-cols-2 xl:grid-cols-3'
                : 'grid-cols-1 sm:grid-cols-2'
            }`}
          >
            {participants.map((participant) => {
              const local = participant.cameraConnId === myConnId
              const stream = local
                ? localStream
                : participant.cameraConnId
                  ? remoteStreams[participant.cameraConnId]
                  : null
              const name =
                users[participant.userId]?.display_name ??
                (me?.id === participant.userId ? me.display_name : 'Participant')
              return (
                <VideoTile
                  key={participant.userId}
                  userId={participant.userId}
                  name={name}
                  stream={stream}
                  local={local}
                  muted={participant.muted}
                  speaking={participant.speaking}
                  compact={stageMode === 'compact'}
                />
              )
            })}
          </div>
        ) : (
          <ul
            aria-label={`${participants.length} participants`}
            className="flex h-full flex-wrap items-center justify-center gap-5 py-4"
          >
            {participants.map((participant) => {
              const name =
                users[participant.userId]?.display_name ??
                (me?.id === participant.userId ? me.display_name : 'Participant')
              return (
                <AudioTile
                  key={participant.userId}
                  userId={participant.userId}
                  name={name}
                  local={me?.id === participant.userId}
                  muted={participant.muted}
                  speaking={participant.speaking}
                  size={avatarSize}
                />
              )
            })}
          </ul>
        )}
      </div>

      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--color-border)] px-3 py-2.5">
        <DeviceControl
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          menuLabel="Choose microphone"
          active={muted}
          onClick={toggleVoiceMute}
          devices={mics}
          selectedDeviceId={audioDeviceId}
          onSelectDevice={(deviceId) => void setVoiceAudioDevice(deviceId)}
          menuPlacement="up"
        >
          <MicIcon off={muted} />
        </DeviceControl>
        <DeviceControl
          label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
          menuLabel="Choose camera"
          active={cameraStatus !== 'off'}
          disabled={cameraStatus === 'starting'}
          onClick={toggleVoiceCamera}
          devices={cameras}
          selectedDeviceId={videoDeviceId}
          onSelectDevice={(deviceId) => void setVoiceVideoDevice(deviceId)}
          menuPlacement="up"
        >
          <CameraIcon off={cameraStatus === 'off'} />
        </DeviceControl>
        <CallControl label="Leave call" danger onClick={leaveVoice}>
          <LeaveIcon />
        </CallControl>
      </footer>
    </section>
  )
}

function AudioTile({
  userId,
  name,
  local,
  muted,
  speaking,
  size,
}: {
  userId: string
  name: string
  local: boolean
  muted: boolean
  speaking: boolean
  size: number
}) {
  return (
    <li className="flex w-24 flex-col items-center gap-2 text-center sm:w-28">
      <div
        className={`relative rounded-full ${
          speaking ? 'ring-2 ring-[#4fbf9f] ring-offset-2 ring-offset-[var(--color-ink)]' : ''
        }`}
      >
        <Avatar id={userId} name={name} size={size} />
        {muted && (
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--color-ink)] bg-[var(--color-panel-2)] text-[var(--color-text-dim)]"
            title="Muted"
          >
            <MicIcon off />
          </span>
        )}
      </div>
      <span className="w-full truncate text-xs font-medium text-[var(--color-text)]">
        {name}
        {local ? ' (you)' : ''}
      </span>
    </li>
  )
}

function VideoTile({
  userId,
  name,
  stream,
  local,
  muted,
  speaking,
  compact,
}: {
  userId: string
  name: string
  stream: MediaStream | null
  local: boolean
  muted: boolean
  speaking: boolean
  compact: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasVideo = Boolean(stream?.getVideoTracks().length)
  const minH = compact ? 'min-h-28' : 'min-h-40'

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = hasVideo ? stream : null
    if (hasVideo) void video.play().catch(() => {})
  }, [hasVideo, stream])

  return (
    <article
      className={`relative flex overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${minH} ${
        speaking ? 'border-[#4fbf9f] ring-2 ring-[#4fbf9f]/30' : 'border-[var(--color-border)]'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${minH} ${local ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div
          className={`flex w-full items-center justify-center bg-[radial-gradient(circle_at_top,var(--color-panel-2),var(--color-panel))] ${minH}`}
        >
          <Avatar id={userId} name={name} size={compact ? 48 : 64} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-6 text-sm font-medium text-white">
        <span className="truncate">
          {name}
          {local ? ' (you)' : ''}
        </span>
        {muted && (
          <span className="ml-auto rounded-full bg-black/45 p-1" title="Muted">
            <MicIcon off />
          </span>
        )}
      </div>
    </article>
  )
}

function CallControl({
  label,
  active = false,
  danger = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
          : active
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-panel-2)] text-[var(--color-text)] hover:bg-[var(--color-border)]'
      }`}
    >
      {children}
    </button>
  )
}

function DeviceControl({
  label,
  menuLabel,
  active = false,
  disabled = false,
  onClick,
  devices,
  selectedDeviceId,
  onSelectDevice,
  menuPlacement = 'down',
  children,
}: {
  label: string
  menuLabel: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  devices: MediaDeviceOption[]
  selectedDeviceId: string | null
  onSelectDevice: (deviceId: string) => void
  menuPlacement?: 'up' | 'down'
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const hasDevices = devices.length > 0

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const shellClass = active
    ? 'bg-[var(--color-accent)] text-white'
    : 'bg-[var(--color-panel-2)] text-[var(--color-text)]'

  return (
    <div ref={rootRef} className="relative flex">
      <div className={`flex overflow-hidden rounded-full ${shellClass}`}>
        <button
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={active}
          disabled={disabled}
          onClick={onClick}
          className="flex h-11 w-11 items-center justify-center outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {children}
        </button>
        <button
          type="button"
          aria-label={menuLabel}
          title={menuLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled || !hasDevices}
          onClick={() => setOpen((value) => !value)}
          className="flex h-11 w-7 items-center justify-center border-l border-black/15 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <CaretIcon />
        </button>
      </div>
      {open && hasDevices && (
        <div
          role="menu"
          aria-label={menuLabel}
          className={`absolute right-0 z-40 max-h-56 min-w-52 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-2xl ${
            menuPlacement === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
        >
          {devices.map((device) => {
            const selected = device.deviceId === selectedDeviceId
            return (
              <button
                key={device.deviceId}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  setOpen(false)
                  onSelectDevice(device.deviceId)
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                  selected
                    ? 'text-[var(--color-accent-hover)]'
                    : 'text-[var(--color-text)]'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{device.label}</span>
                {selected && <CheckIcon />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CaretIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m5 12 5 5L20 7" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M15 3h6v6" />
      <path d="m21 3-7 7" />
      <path d="M9 21H3v-6" />
      <path d="m3 21 7-7" />
    </svg>
  )
}

function ReduceIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 3v5H3" />
      <path d="m3 8 5-5" />
      <path d="M16 21v-5h5" />
      <path d="m21 16-5 5" />
    </svg>
  )
}

function MinimizeIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M5 12h14" />
    </svg>
  )
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m16 13 5 3V8l-5 3" />
      <rect x="3" y="6" width="13" height="12" rx="2" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 17 5 12l5-5" />
      <path d="M5 12h12" />
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </svg>
  )
}
