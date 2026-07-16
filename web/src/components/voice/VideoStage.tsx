import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useStore, type VoiceStageMode } from '../../store'
import { channelLabel } from '../../lib/util'
import { toastError, toastSuccess } from '../../lib/toast'
import { Avatar } from '../Avatar'
import { VoiceMiniWidget } from './VoiceMiniWidget'
import { CallChatRail } from './CallChatRail'
import { useVoicePip } from './VoicePip'

type StageParticipant = {
  userId: string
  connIds: string[]
  displayName: string
  guest: boolean
  muted: boolean
  speaking: boolean
  cameraConnId: string | null
}

type MediaDeviceOption = {
  deviceId: string
  label: string
}

// Adaptive video grid: how many columns for N tiles so everything fits and
// partial last rows can be centered. 1→1, 2→2, 3→3 across, 4→2x2, else √n.
function gridColsFor(count: number): number {
  if (count <= 1) return 1
  if (count === 2) return 2
  if (count === 3) return 3
  if (count === 4) return 2
  return Math.ceil(Math.sqrt(count))
}

const STAGE_SIZE: Record<
  Exclude<VoiceStageMode, 'mini' | 'full'>,
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
  const screenStatus = useStore((s) => s.voice.screenStatus)
  const audioDeviceId = useStore((s) => s.voice.audioDeviceId)
  const videoDeviceId = useStore((s) => s.voice.videoDeviceId)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const localScreenStream = useStore((s) => s.voice.localScreenStream)
  const remoteScreenStreams = useStore((s) => s.voice.remoteScreenStreams)
  const myConnId = useStore((s) => s.myConnId)
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const isGuest = useStore((s) => s.isGuest)
  const channel = useStore((s) => s.channels.find((candidate) => candidate.id === channelId))
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const toggleVoiceScreen = useStore((s) => s.toggleVoiceScreen)
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
  const [chatOpen, setChatOpen] = useState(true)
  const hasFallbackVideo = Boolean(
    localStream?.getVideoTracks().length ||
      Object.values(remoteStreams).some((stream) => stream.getVideoTracks().length > 0),
  )
  const pip = useVoicePip(hasFallbackVideo)

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

  // Esc leaves full screen (Slack-style). Skip if something already handled the
  // key (e.g. the composer closing its mention picker calls preventDefault).
  useEffect(() => {
    if (stageMode !== 'full') return
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setVoiceStageMode('expanded')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stageMode, setVoiceStageMode])

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
          displayName: entry.display_name,
          guest: entry.guest,
          muted: entry.muted,
          speaking: Boolean(speaking[connId]),
          cameraConnId: entry.camera_on ? connId : null,
        })
      }
    }
    return [...byUser.values()]
  }, [myConnId, room, speaking])

  const screenShares = useMemo(() => {
    const shares: {
      connId: string
      userId: string
      displayName: string
      local: boolean
      stream: MediaStream | null
    }[] = []
    for (const [connId, entry] of Object.entries(room ?? {})) {
      if (!entry.screen_on) continue
      const local = connId === myConnId
      shares.push({
        connId,
        userId: entry.user_id,
        displayName: entry.display_name,
        local,
        stream: local ? localScreenStream : remoteScreenStreams[connId] ?? null,
      })
    }
    return shares
  }, [room, myConnId, localScreenStream, remoteScreenStreams])

  // Name resolution: prefer the directory entry (members), then our own name,
  // then the server-filled display_name carried on the voice room (covers guests
  // who aren't in the directory), finally a generic fallback.
  const resolveName = (userId: string, roomName?: string): string =>
    users[userId]?.display_name ??
    (me?.id === userId ? me.display_name : undefined) ??
    roomName ??
    'Participant'

  const activeScreen = screenShares[0] ?? null
  const otherSharer = screenShares.find((share) => !share.local)
  const someoneElseSharing = Boolean(otherSharer)
  const otherSharerName = otherSharer
    ? resolveName(otherSharer.userId, otherSharer.displayName)
    : ''

  if (!channelId) return null
  if (pip.pipWindow) {
    return (
      <>
        {pip.portal}
        <button
          type="button"
          onClick={pip.closeAndFocus}
          className="fixed bottom-4 right-4 z-50 rounded-full border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-xs font-medium text-[var(--color-text)] shadow-2xl outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          Call is in picture-in-picture
        </button>
      </>
    )
  }
  if (stageMode === 'mini') return <VoiceMiniWidget />

  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Call'
  const anyCamera = participants.some((p) => p.cameraConnId)
  const avatarSize = stageMode === 'compact' ? 56 : 88
  const cols = gridColsFor(participants.length)
  const headerBtnClass =
    'flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]'

  const stageBody = activeScreen ? (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="min-h-0 flex-1">
        <ScreenTile
          name={resolveName(activeScreen.userId, activeScreen.displayName)}
          stream={activeScreen.stream}
          local={activeScreen.local}
        />
      </div>
      {participants.length > 0 && (
        <ul
          aria-label="Call participants"
          className="flex shrink-0 items-center gap-2 overflow-x-auto pt-0.5"
        >
          {participants.map((participant) => {
            const name = resolveName(participant.userId, participant.displayName)
            if (stageMode === 'compact') {
              return (
                <AudioTile
                  key={participant.userId}
                  userId={participant.userId}
                  name={name}
                  guest={participant.guest}
                  local={me?.id === participant.userId}
                  muted={participant.muted}
                  speaking={participant.speaking}
                  size={40}
                />
              )
            }
            const local = participant.cameraConnId === myConnId
            const stream = local
              ? localStream
              : participant.cameraConnId
                ? remoteStreams[participant.cameraConnId]
                : null
            return (
              <li key={participant.userId} className="w-40 shrink-0">
                <VideoTile
                  userId={participant.userId}
                  name={name}
                  guest={participant.guest}
                  stream={stream}
                  local={local}
                  muted={participant.muted}
                  speaking={participant.speaking}
                  compact
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  ) : anyCamera ? (
    // Adaptive grid via flex-wrap: `cols` tiles per row (see gridColsFor) sized to
    // fill the row width, so a partial final row stays centered.
    <div className="flex h-full flex-wrap content-center items-center justify-center gap-3">
      {participants.map((participant) => {
        const local = participant.cameraConnId === myConnId
        const stream = local
          ? localStream
          : participant.cameraConnId
            ? remoteStreams[participant.cameraConnId]
            : null
        const name = resolveName(participant.userId, participant.displayName)
        return (
          <div
            key={participant.userId}
            className="min-w-0 shrink-0"
            style={{ width: `calc((100% - ${(cols - 1) * 0.75}rem) / ${cols})` }}
          >
            <VideoTile
              userId={participant.userId}
              name={name}
              guest={participant.guest}
              stream={stream}
              local={local}
              muted={participant.muted}
              speaking={participant.speaking}
              compact={stageMode === 'compact'}
            />
          </div>
        )
      })}
    </div>
  ) : (
    <ul
      aria-label={`${participants.length} participants`}
      className="flex h-full flex-wrap content-center items-center justify-center gap-5 py-4"
    >
      {participants.map((participant) => {
        const name = resolveName(participant.userId, participant.displayName)
        return (
          <AudioTile
            key={participant.userId}
            userId={participant.userId}
            name={name}
            guest={participant.guest}
            local={me?.id === participant.userId}
            muted={participant.muted}
            speaking={participant.speaking}
            size={avatarSize}
          />
        )
      })}
    </ul>
  )

  const stageControls = (
    <>
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
      <CallControl
        label={
          someoneElseSharing
            ? `${otherSharerName} is sharing`
            : screenStatus === 'on'
              ? 'Stop sharing screen'
              : 'Share screen'
        }
        active={screenStatus !== 'off'}
        disabled={screenStatus === 'starting' || someoneElseSharing}
        onClick={() => void toggleVoiceScreen()}
      >
        <ScreenShareIcon />
      </CallControl>
      <CallControl label="Leave call" danger onClick={leaveVoice}>
        <LeaveIcon />
      </CallControl>
    </>
  )

  if (stageMode === 'full') {
    return (
      <section
        aria-label={`${roomName} huddle`}
        className="fixed inset-0 z-[60] flex bg-black text-[var(--color-text)]"
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 px-5">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
                Huddle
              </div>
              <div className="truncate text-sm font-semibold">{roomName}</div>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {!isGuest && (
                <CopyLinkControl channelId={channelId} buttonClass={headerBtnClass} />
              )}
              {pip.supported && (
                <button
                  type="button"
                  aria-label="Open picture-in-picture"
                  title="Picture-in-picture"
                  onClick={() => void pip.open()}
                  className={headerBtnClass}
                >
                  <PipIcon />
                </button>
              )}
              {!isGuest && (
                <button
                  type="button"
                  aria-label={chatOpen ? 'Hide chat' : 'Show chat'}
                  title={chatOpen ? 'Hide chat' : 'Show chat'}
                  aria-pressed={chatOpen}
                  onClick={() => setChatOpen((value) => !value)}
                  className={headerBtnClass}
                >
                  <ChatIcon />
                </button>
              )}
              <button
                type="button"
                aria-label="Minimize call"
                title="Minimize"
                onClick={() => setVoiceStageMode('mini')}
                className={headerBtnClass}
              >
                <MinimizeIcon />
              </button>
              <button
                type="button"
                aria-label="Exit full screen"
                title="Exit full screen (Esc)"
                onClick={() => setVoiceStageMode('expanded')}
                className={headerBtnClass}
              >
                <ReduceIcon />
              </button>
            </div>
          </header>

          <div className="min-h-0 flex-1 overflow-hidden px-8 pb-24 pt-2">{stageBody}</div>

          <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--color-border)] bg-[var(--color-ink)]/90 px-3 py-2 shadow-2xl backdrop-blur">
              {stageControls}
            </div>
          </div>
        </div>

        {!isGuest && (
          <div
            className="shrink-0 overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-ink)] transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{ width: chatOpen ? 380 : 0 }}
          >
            <div className="h-full w-[380px]">
              <CallChatRail channelId={channelId} />
            </div>
          </div>
        )}
      </section>
    )
  }

  const size = STAGE_SIZE[stageMode]

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
        {!isGuest && (
          <CopyLinkControl channelId={channelId} buttonClass={headerBtnClass} />
        )}
        {pip.supported && (
          <button
            type="button"
            aria-label="Open picture-in-picture"
            title="Picture-in-picture"
            onClick={() => void pip.open()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <PipIcon />
          </button>
        )}
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
          aria-label="Full screen"
          title="Full screen"
          onClick={() => setVoiceStageMode('full')}
          className={headerBtnClass}
        >
          <FullscreenIcon />
        </button>
        <button
          type="button"
          aria-label="Minimize call"
          title="Minimize"
          onClick={() => setVoiceStageMode('mini')}
          className={headerBtnClass}
        >
          <MinimizeIcon />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">{stageBody}</div>

      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--color-border)] px-3 py-2.5">
        {stageControls}
      </footer>
    </section>
  )
}

function AudioTile({
  userId,
  name,
  guest = false,
  local,
  muted,
  speaking,
  size,
}: {
  userId: string
  name: string
  guest?: boolean
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
      <span className="flex w-full items-center justify-center gap-1 truncate text-xs font-medium text-[var(--color-text)]">
        <span className="truncate">
          {name}
          {local ? ' (you)' : ''}
        </span>
        {guest && <GuestBadge />}
      </span>
    </li>
  )
}

function VideoTile({
  userId,
  name,
  guest = false,
  stream,
  local,
  muted,
  speaking,
  compact,
}: {
  userId: string
  name: string
  guest?: boolean
  stream: MediaStream | null
  local: boolean
  muted: boolean
  speaking: boolean
  compact: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasVideo = Boolean(stream?.getVideoTracks().length)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = hasVideo ? stream : null
    if (hasVideo) void video.play().catch(() => {})
  }, [hasVideo, stream])

  return (
    <article
      className={`relative flex aspect-video w-full overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${
        speaking ? 'border-[#4fbf9f] ring-2 ring-[#4fbf9f]/30' : 'border-[var(--color-border)]'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          data-voice-video
          data-voice-video-local={local ? 'true' : undefined}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${local ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,var(--color-panel-2),var(--color-panel))]">
          <Avatar id={userId} name={name} size={compact ? 48 : 64} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-6 text-sm font-medium text-white">
        <span className="truncate">
          {name}
          {local ? ' (you)' : ''}
        </span>
        {guest && <GuestBadge onDark />}
        {muted && (
          <span className="ml-auto rounded-full bg-black/45 p-1" title="Muted">
            <MicIcon off />
          </span>
        )}
      </div>
    </article>
  )
}

// Members-only header control: copy or regenerate the channel's public call
// link. Lazily resolves/creates the token only when an action is taken.
function CopyLinkControl({
  channelId,
  buttonClass,
}: {
  channelId: string
  buttonClass: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  async function writeLink(token: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/call/${token}`)
  }

  async function copyExisting() {
    if (busy) return
    setBusy(true)
    try {
      const { token } = await api.voiceLink.get(channelId)
      const active = token ?? (await api.voiceLink.create(channelId)).token
      await writeLink(active)
      toastSuccess('Call link copied')
      setOpen(false)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not copy the call link.')
    } finally {
      setBusy(false)
    }
  }

  async function newLink() {
    if (busy) return
    setBusy(true)
    try {
      const { token } = await api.voiceLink.create(channelId)
      await writeLink(token)
      toastSuccess('New call link copied — old link revoked')
      setOpen(false)
    } catch (e) {
      toastError(e instanceof Error ? e.message : 'Could not create a call link.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={rootRef} className="relative flex">
      <button
        type="button"
        aria-label="Call link"
        title="Call link"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={buttonClass}
      >
        <LinkIcon />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Call link"
          className="absolute right-0 top-full z-40 mt-1 min-w-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1 shadow-2xl"
        >
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void copyExisting()}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--color-text)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-60"
          >
            Copy call link
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => void newLink()}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--color-text)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-60"
          >
            New link (revokes old)
          </button>
        </div>
      )}
    </div>
  )
}

// Small quiet "Guest" chip shown next to a participant's name when they joined
// via a public call link. `onDark` variant sits over the video tile gradient.
function GuestBadge({ onDark = false }: { onDark?: boolean }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide ${
        onDark
          ? 'bg-white/20 text-white'
          : 'bg-[var(--color-panel-2)] text-[var(--color-text-dim)]'
      }`}
    >
      Guest
    </span>
  )
}

function ScreenTile({
  name,
  stream,
  local,
}: {
  name: string
  stream: MediaStream | null
  local: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hasVideo = Boolean(stream?.getVideoTracks().length)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.srcObject = hasVideo ? stream : null
    if (hasVideo) void video.play().catch(() => {})
  }, [hasVideo, stream])

  return (
    <article className="relative flex h-full w-full overflow-hidden rounded-2xl border border-[var(--color-border)] bg-black">
      {hasVideo ? (
        // Never mirrored; object-contain keeps the whole surface visible. Muted —
        // remote system/tab audio plays via the engine's hidden screenAudio element.
        <video
          ref={videoRef}
          data-voice-video
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-[var(--color-text-dim)]">
          Waiting for screen…
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pb-2.5 pt-6 text-sm font-medium text-white">
        <ScreenShareIcon />
        <span className="truncate">{local ? 'Your screen' : `${name}'s screen`}</span>
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

function FullscreenIcon() {
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
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  )
}

function ChatIcon() {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function LinkIcon() {
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function PipIcon() {
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
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" />
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

function ScreenShareIcon() {
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
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
      <path d="m9 11 3-3 3 3" />
      <path d="M12 8v6" />
    </svg>
  )
}
