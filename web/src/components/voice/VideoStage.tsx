import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { isSpeechSupported } from '../../lib/speech'
import { useIsMobile } from '../../lib/useMediaQuery'
import { useStore, type VoiceStageMode } from '../../store'
import { channelLabel } from '../../lib/util'
import { toastError, toastSuccess } from '../../lib/toast'
import { Avatar } from '../Avatar'
import { VoiceMiniWidget } from './VoiceMiniWidget'
import { CallChatRail } from './CallChatRail'
import { VoiceDuckSuggest } from './VoiceDuckSuggest'
import { useVoicePip } from './VoicePip'
import { MicActivityIcon } from './MicActivityIcon'

type StageParticipant = {
  userId: string
  connIds: string[]
  displayName: string
  guest: boolean
  muted: boolean
  transcribing: boolean
  speaking: boolean
  handRaised: boolean
  handRaisedAt: number | null
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

// Earliest of two raise timestamps (a user with multiple conns keeps the oldest).
function earliestHand(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

// Sort raised hands first (oldest raise first); non-raised keep their order via
// Array#sort stability.
function handOrder(a: StageParticipant, b: StageParticipant): number {
  if (a.handRaised !== b.handRaised) return a.handRaised ? -1 : 1
  if (a.handRaised && b.handRaised) return (a.handRaisedAt ?? 0) - (b.handRaisedAt ?? 0)
  return 0
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

export function VideoStage({ roomName: roomNameOverride }: { roomName?: string } = {}) {
  const { token: currentLinkToken } = useParams<{ token?: string }>()
  const channelId = useStore((s) => s.voice.channelId)
  const stageMode = useStore((s) => s.voice.stageMode)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const activeMeetingId = useStore((s) =>
    channelId ? s.activeMeetings[channelId] ?? null : null,
  )
  const speaking = useStore((s) => s.voice.speaking)
  const transcribing = useStore((s) => s.voice.transcribing)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const localScreenStream = useStore((s) => s.voice.localScreenStream)
  const remoteScreenStreams = useStore((s) => s.voice.remoteScreenStreams)
  const myConnId = useStore((s) => s.myConnId)
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const isGuest = useStore((s) => s.isGuest)
  const channel = useStore((s) => s.channels.find((candidate) => candidate.id === channelId))
  const toggleTranscription = useStore((s) => s.toggleTranscription)
  const setVoiceStageMode = useStore((s) => s.setVoiceStageMode)
  const isMobile = useIsMobile()
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
  const [handledNotesMeetingId, setHandledNotesMeetingId] = useState<string | null>(null)
  const hasFallbackVideo = Boolean(
    localStream?.getVideoTracks().length ||
      localScreenStream?.getVideoTracks().length ||
      Object.values(remoteStreams).some((stream) => stream.getVideoTracks().length > 0) ||
      Object.values(remoteScreenStreams).some((stream) => stream.getVideoTracks().length > 0),
  )
  const pip = useVoicePip(hasFallbackVideo)

  useEffect(() => {
    if (activeMeetingId && transcribing) setHandledNotesMeetingId(activeMeetingId)
  }, [activeMeetingId, transcribing])

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
        existing.transcribing = existing.transcribing || entry.transcribing
        existing.speaking = existing.speaking || Boolean(speaking[connId])
        if (entry.hand_raised) {
          existing.handRaised = true
          existing.handRaisedAt = earliestHand(existing.handRaisedAt, entry.hand_raised_at)
        }
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
          transcribing: entry.transcribing,
          speaking: Boolean(speaking[connId]),
          handRaised: entry.hand_raised,
          handRaisedAt: entry.hand_raised ? entry.hand_raised_at : null,
          cameraConnId: entry.camera_on ? connId : null,
        })
      }
    }
    // Raised hands float to the front, oldest raise first; everyone else keeps
    // their existing (insertion) order.
    return [...byUser.values()].sort(handOrder)
  }, [myConnId, room, speaking])
  const sharingCount = participants.filter((participant) => participant.transcribing).length

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

  const notesConsentPrompt =
    activeMeetingId &&
    !transcribing &&
    handledNotesMeetingId !== activeMeetingId &&
    isSpeechSupported() ? (
      <NotesConsentPrompt
        onAccept={() => {
          setHandledNotesMeetingId(activeMeetingId)
          toggleTranscription()
        }}
        onDismiss={() => setHandledNotesMeetingId(activeMeetingId)}
      />
    ) : null

  if (!channelId) return null
  if (pip.pipWindow) {
    return (
      <>
        {pip.portal}
        {notesConsentPrompt}
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
  if (stageMode === 'mini') {
    return (
      <>
        <VoiceMiniWidget />
        {notesConsentPrompt}
      </>
    )
  }

  const roomName = roomNameOverride ?? (channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Meet')
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
                  transcribing={participant.transcribing}
                  speaking={participant.speaking}
                  handRaised={participant.handRaised}
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
                  transcribing={participant.transcribing}
                  speaking={participant.speaking}
                  handRaised={participant.handRaised}
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
              transcribing={participant.transcribing}
              speaking={participant.speaking}
              handRaised={participant.handRaised}
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
            transcribing={participant.transcribing}
            speaking={participant.speaking}
            handRaised={participant.handRaised}
            size={avatarSize}
          />
        )
      })}
    </ul>
  )

  const stageControls = (
    <StageControlsBar
      mics={mics}
      cameras={cameras}
      someoneElseSharing={someoneElseSharing}
      otherSharerName={otherSharerName}
    />
  )

  if (stageMode === 'full') {
    return (
      <section
        aria-label={`${roomName} huddle`}
        className="voice-stage fixed inset-0 z-[60] flex bg-black text-[var(--color-text)]"
      >
        <div className="relative flex min-w-0 flex-1 flex-col">
          <header
            className="flex h-14 shrink-0 items-center gap-3 px-5"
            style={{
              paddingTop: 'var(--safe-top)',
              height: 'calc(3.5rem + var(--safe-top))',
              paddingLeft: 'max(1.25rem, var(--safe-left))',
              paddingRight: 'max(1.25rem, var(--safe-right))',
            }}
          >
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-faint)]">
                Huddle
              </div>
              <div className="truncate text-sm font-semibold">{roomName}</div>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {!isGuest && (channel || currentLinkToken) && (
                <CopyLinkControl channelId={channel?.id} directToken={currentLinkToken} buttonClass={headerBtnClass} />
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
              {!isGuest && channel?.is_member && (
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

          <div className="relative min-h-0 flex-1 overflow-hidden px-8 pb-24 pt-2">
            {stageBody}
            {channel?.is_member ? <VoiceDuckSuggest /> : null}
          </div>

          <div
            className="pointer-events-none absolute inset-x-0 flex justify-center px-3"
            style={{ bottom: 'max(1.5rem, var(--safe-bottom))' }}
          >
            <div className="pointer-events-auto voice-cmd-bar flex items-center justify-center gap-2 rounded-[1.35rem] border border-[var(--color-border)] bg-[var(--color-ink)]/92 px-2.5 py-2 shadow-2xl backdrop-blur-md sm:gap-2.5 sm:px-3">
              {stageControls}
            </div>
          </div>
        </div>

        {!isGuest && channel?.is_member && (
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

  const size = isMobile
    ? {
        ...STAGE_SIZE[stageMode],
        width: 'min(920px, calc(100vw - 1rem))',
        height:
          stageMode === 'expanded'
            ? 'min(640px, calc(100dvh - var(--mobile-tab-h) - 1.25rem))'
            : 'min(320px, calc(100dvh - var(--mobile-tab-h) - 1.25rem))',
        minWidth: 280,
        minHeight: stageMode === 'expanded' ? 300 : 220,
      }
    : STAGE_SIZE[stageMode]

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
    <>
    <section
      ref={panelRef}
      aria-label={`${roomName} huddle`}
      className={`voice-stage fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-ink)] shadow-2xl ${
        dragging ? '' : 'transition-[width,height] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={{
        width: size.width,
        height: size.height,
        minWidth: size.minWidth,
        minHeight: size.minHeight,
        resize: isMobile ? 'none' : 'both',
        ...(position
          ? { left: position.left, top: position.top }
          : isMobile
            ? { left: '0.5rem', right: '0.5rem', bottom: 'calc(var(--mobile-tab-h) + 0.5rem)', width: 'auto' }
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
        {activeMeetingId && (
          <div
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-[#ff6b5f]/35 bg-[#ff6b5f]/10 px-2.5 py-1 text-[10px] font-semibold text-[#ff8a80]"
            title="Meeting record is active. Only opted-in microphones are transcribed."
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b5f]" />
            Notes on · {sharingCount} sharing
          </div>
        )}
        {!isGuest && (channel || currentLinkToken) && (
          <CopyLinkControl channelId={channel?.id} directToken={currentLinkToken} buttonClass={headerBtnClass} />
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

      <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
        {stageBody}
        {channel?.is_member ? <VoiceDuckSuggest /> : null}
      </div>

      <footer className="flex shrink-0 items-center justify-center border-t border-[var(--color-border)] px-2 py-2.5 sm:px-3">
        <div className="voice-cmd-bar flex w-full max-w-lg items-center justify-center gap-2 sm:w-auto sm:gap-2.5">
          {stageControls}
        </div>
      </footer>
    </section>
    {notesConsentPrompt}
    </>
  )
}

function NotesConsentPrompt({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void
  onDismiss: () => void
}) {
  return (
    <aside
      role="dialog"
      aria-labelledby="meeting-notes-prompt-title"
      aria-describedby="meeting-notes-prompt-description"
      className="fixed bottom-5 left-1/2 z-[70] w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-[#ff6b5f]/35 bg-[var(--color-panel)] shadow-[0_24px_70px_-22px_rgba(0,0,0,0.9)]"
    >
      <div className="h-0.5 w-full bg-[#ff6b5f]" />
      <div className="grid grid-cols-[auto_1fr] gap-3 p-4 sm:p-5">
        <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-[#ff6b5f]/10 text-[#ff8a80] ring-1 ring-[#ff6b5f]/20">
          <CaptionsIcon />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[#ff6b5f]" />
            <h2 id="meeting-notes-prompt-title" className="text-sm font-semibold">
              Meeting notes are on
            </h2>
          </div>
          <p
            id="meeting-notes-prompt-description"
            className="mt-1.5 text-xs leading-5 text-[var(--color-text-dim)]"
          >
            Share your microphone transcript so your speech is attributed to you. No audio or
            video is recorded.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={onAccept}
              className="rounded-lg bg-[#ff6b5f] px-3.5 py-2 text-xs font-semibold text-white outline-none hover:bg-[#ff7d72] focus-visible:ring-2 focus-visible:ring-[#ff8a80] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-panel)]"
            >
              Share my transcript
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}

function AudioTile({
  userId,
  name,
  guest = false,
  local,
  muted,
  transcribing,
  speaking,
  handRaised,
  size,
}: {
  userId: string
  name: string
  guest?: boolean
  local: boolean
  muted: boolean
  transcribing: boolean
  speaking: boolean
  handRaised: boolean
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
        {handRaised && (
          <span
            className="absolute -right-0.5 -top-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--color-ink)] bg-amber-400 text-[#3a2a00]"
            title="Hand raised"
          >
            <HandIcon compact />
          </span>
        )}
        {muted && (
          <span
            className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--color-ink)] bg-[var(--color-panel-2)] text-[var(--color-text-dim)]"
            title="Muted"
          >
            <MicIcon off />
          </span>
        )}
        {transcribing && (
          <span
            className="absolute -bottom-0.5 -left-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-[var(--color-ink)] bg-[var(--color-panel-2)] text-[var(--color-accent-hover)]"
            title="Transcribing"
          >
            <CaptionsIcon compact />
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
  transcribing,
  speaking,
  handRaised,
  compact,
}: {
  userId: string
  name: string
  guest?: boolean
  stream: MediaStream | null
  local: boolean
  muted: boolean
  transcribing: boolean
  speaking: boolean
  handRaised: boolean
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
        {(handRaised || transcribing || muted) && (
          <span className="ml-auto flex items-center gap-1">
            {handRaised && (
              <span
                className="rounded-full bg-amber-400/90 p-1 text-[#3a2a00]"
                title="Hand raised"
              >
                <HandIcon compact />
              </span>
            )}
            {transcribing && (
              <span
                className="rounded-full bg-black/45 p-1 text-[var(--color-accent-hover)]"
                title="Transcribing"
              >
                <CaptionsIcon compact />
              </span>
            )}
            {muted && (
              <span className="rounded-full bg-black/45 p-1" title="Muted">
                <MicIcon off />
              </span>
            )}
          </span>
        )}
      </div>
    </article>
  )
}

// Header control: link routes can copy their known token directly; channel
// members can lazily resolve or regenerate the channel's public call link.
function CopyLinkControl({
  channelId,
  directToken,
  buttonClass,
}: {
  channelId?: string
  directToken?: string
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
      const active = directToken ?? (channelId
        ? (await api.voiceLink.get(channelId)).token ?? (await api.voiceLink.create(channelId)).token
        : null)
      if (!active) throw new Error('Call link unavailable.')
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
    if (busy || !channelId) return
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
          {channelId ? (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void newLink()}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--color-text)] outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-60"
            >
              New link (revokes old)
            </button>
          ) : null}
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
          data-voice-screen
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

function StageControlsBar({
  mics,
  cameras,
  someoneElseSharing,
  otherSharerName,
}: {
  mics: MediaDeviceOption[]
  cameras: MediaDeviceOption[]
  someoneElseSharing: boolean
  otherSharerName: string
}) {
  const isMobile = useIsMobile()
  const [moreOpen, setMoreOpen] = useState(false)
  const muted = useStore((s) => s.voice.muted)
  const noiseSuppression = useStore((s) => s.voice.noiseSuppression)
  const noiseSuppressionAvailable = useStore((s) => s.voice.noiseSuppressionAvailable)
  const handRaised = useStore((s) => s.voice.handRaised)
  const transcribing = useStore((s) => s.voice.transcribing)
  const voiceStatus = useStore((s) => s.voice.status)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const blurEnabled = useStore((s) => s.voice.blurEnabled)
  const screenStatus = useStore((s) => s.voice.screenStatus)
  const audioDeviceId = useStore((s) => s.voice.audioDeviceId)
  const videoDeviceId = useStore((s) => s.voice.videoDeviceId)
  const channelId = useStore((s) => s.voice.channelId)
  const activeMeetingId = useStore((s) =>
    channelId ? s.activeMeetings[channelId] ?? null : null,
  )
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleNoiseSuppression = useStore((s) => s.toggleNoiseSuppression)
  const toggleVoiceHand = useStore((s) => s.toggleVoiceHand)
  const toggleTranscription = useStore((s) => s.toggleTranscription)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const toggleVoiceBlur = useStore((s) => s.toggleVoiceBlur)
  const toggleVoiceScreen = useStore((s) => s.toggleVoiceScreen)
  const setVoiceAudioDevice = useStore((s) => s.setVoiceAudioDevice)
  const setVoiceVideoDevice = useStore((s) => s.setVoiceVideoDevice)
  const leaveVoice = useStore((s) => s.leaveVoice)

  const secondaryActive =
    (noiseSuppression && noiseSuppressionAvailable) ||
    handRaised ||
    transcribing ||
    blurEnabled ||
    screenStatus !== 'off'

  if (isMobile) {
    return (
      <>
        <CallControl
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          active={!muted}
          size="lg"
          onClick={toggleVoiceMute}
        >
          <MicActivityIcon muted={muted} />
        </CallControl>
        <CallControl
          label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
          active={cameraStatus !== 'off'}
          disabled={cameraStatus === 'starting'}
          size="lg"
          onClick={toggleVoiceCamera}
        >
          <CameraIcon off={cameraStatus === 'off'} />
        </CallControl>
        <CallControl
          label="More call controls"
          active={moreOpen || secondaryActive}
          size="lg"
          onClick={() => setMoreOpen((open) => !open)}
        >
          <MoreCallIcon />
        </CallControl>
        <CallControl label="Leave call" danger size="lg" onClick={leaveVoice}>
          <LeaveIcon />
        </CallControl>
        {moreOpen && (
          <MobileCallMoreSheet
            mics={mics}
            cameras={cameras}
            someoneElseSharing={someoneElseSharing}
            otherSharerName={otherSharerName}
            onClose={() => setMoreOpen(false)}
          />
        )}
      </>
    )
  }

  return (
    <>
      <DeviceControl
        label={muted ? 'Unmute microphone' : 'Mute microphone'}
        menuLabel="Choose microphone"
        active={!muted}
        onClick={toggleVoiceMute}
        devices={mics}
        selectedDeviceId={audioDeviceId}
        onSelectDevice={(deviceId) => void setVoiceAudioDevice(deviceId)}
        menuPlacement="up"
      >
        <MicActivityIcon muted={muted} />
      </DeviceControl>
      <CallControl
        label={
          !noiseSuppressionAvailable
            ? 'Noise suppression unavailable'
            : noiseSuppression
              ? 'Turn off noise suppression'
              : 'Turn on noise suppression'
        }
        active={noiseSuppression && noiseSuppressionAvailable}
        disabled={voiceStatus !== 'connected' || !noiseSuppressionAvailable}
        onClick={() => void toggleNoiseSuppression()}
      >
        <NoiseSuppressionIcon off={!noiseSuppression || !noiseSuppressionAvailable} />
      </CallControl>
      {isSpeechSupported() && (
        <CallControl
          label={
            transcribing
              ? 'Stop sharing my transcript'
              : activeMeetingId
                ? 'Share my transcript'
                : 'Start meeting notes'
          }
          active={transcribing}
          disabled={voiceStatus !== 'connected'}
          onClick={toggleTranscription}
        >
          <CaptionsIcon />
        </CallControl>
      )}
      <CallControl
        label={handRaised ? 'Lower hand' : 'Raise hand'}
        active={handRaised}
        disabled={voiceStatus !== 'connected'}
        onClick={toggleVoiceHand}
      >
        <HandIcon />
      </CallControl>
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
        label={blurEnabled ? 'Turn off background blur' : 'Blur my background'}
        active={blurEnabled}
        disabled={voiceStatus !== 'connected'}
        onClick={toggleVoiceBlur}
      >
        <BlurIcon off={!blurEnabled} />
      </CallControl>
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
}

function MobileCallMoreSheet({
  mics,
  cameras,
  someoneElseSharing,
  otherSharerName,
  onClose,
}: {
  mics: MediaDeviceOption[]
  cameras: MediaDeviceOption[]
  someoneElseSharing: boolean
  otherSharerName: string
  onClose: () => void
}) {
  const noiseSuppression = useStore((s) => s.voice.noiseSuppression)
  const noiseSuppressionAvailable = useStore((s) => s.voice.noiseSuppressionAvailable)
  const handRaised = useStore((s) => s.voice.handRaised)
  const transcribing = useStore((s) => s.voice.transcribing)
  const voiceStatus = useStore((s) => s.voice.status)
  const blurEnabled = useStore((s) => s.voice.blurEnabled)
  const screenStatus = useStore((s) => s.voice.screenStatus)
  const audioDeviceId = useStore((s) => s.voice.audioDeviceId)
  const videoDeviceId = useStore((s) => s.voice.videoDeviceId)
  const channelId = useStore((s) => s.voice.channelId)
  const activeMeetingId = useStore((s) =>
    channelId ? s.activeMeetings[channelId] ?? null : null,
  )
  const toggleNoiseSuppression = useStore((s) => s.toggleNoiseSuppression)
  const toggleVoiceHand = useStore((s) => s.toggleVoiceHand)
  const toggleTranscription = useStore((s) => s.toggleTranscription)
  const toggleVoiceBlur = useStore((s) => s.toggleVoiceBlur)
  const toggleVoiceScreen = useStore((s) => s.toggleVoiceScreen)
  const setVoiceAudioDevice = useStore((s) => s.setVoiceAudioDevice)
  const setVoiceVideoDevice = useStore((s) => s.setVoiceVideoDevice)

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[80]" role="dialog" aria-modal="true" aria-label="Call controls">
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/55"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-[var(--mobile-tab-h)] z-[81] max-h-[min(70dvh,32rem)] overflow-y-auto rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl">
        <div className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-4 pb-3 pt-3">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-[var(--color-border)]" />
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-tight">Call controls</h2>
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="space-y-1 px-2 py-2">
          <SheetAction
            label={
              !noiseSuppressionAvailable
                ? 'Noise suppression unavailable'
                : noiseSuppression
                  ? 'Noise suppression on'
                  : 'Noise suppression off'
            }
            active={noiseSuppression && noiseSuppressionAvailable}
            disabled={voiceStatus !== 'connected' || !noiseSuppressionAvailable}
            icon={<NoiseSuppressionIcon off={!noiseSuppression || !noiseSuppressionAvailable} />}
            onClick={() => void toggleNoiseSuppression()}
          />
          {isSpeechSupported() && (
            <SheetAction
              label={
                transcribing
                  ? 'Stop sharing transcript'
                  : activeMeetingId
                    ? 'Share my transcript'
                    : 'Start meeting notes'
              }
              active={transcribing}
              disabled={voiceStatus !== 'connected'}
              icon={<CaptionsIcon />}
              onClick={toggleTranscription}
            />
          )}
          <SheetAction
            label={handRaised ? 'Lower hand' : 'Raise hand'}
            active={handRaised}
            disabled={voiceStatus !== 'connected'}
            icon={<HandIcon />}
            onClick={toggleVoiceHand}
          />
          <SheetAction
            label={blurEnabled ? 'Background blur on' : 'Blur background'}
            active={blurEnabled}
            disabled={voiceStatus !== 'connected'}
            icon={<BlurIcon off={!blurEnabled} />}
            onClick={toggleVoiceBlur}
          />
          <SheetAction
            label={
              someoneElseSharing
                ? `${otherSharerName} is sharing`
                : screenStatus === 'on'
                  ? 'Stop screen share'
                  : 'Share screen'
            }
            active={screenStatus !== 'off'}
            disabled={screenStatus === 'starting' || someoneElseSharing}
            icon={<ScreenShareIcon />}
            onClick={() => void toggleVoiceScreen()}
          />
        </div>

        {mics.length > 0 && (
          <DevicePickerSection
            title="Microphone"
            devices={mics}
            selectedDeviceId={audioDeviceId}
            onSelect={(deviceId) => {
              void setVoiceAudioDevice(deviceId)
            }}
          />
        )}
        {cameras.length > 0 && (
          <DevicePickerSection
            title="Camera"
            devices={cameras}
            selectedDeviceId={videoDeviceId}
            onSelect={(deviceId) => {
              void setVoiceVideoDevice(deviceId)
            }}
          />
        )}
        <div className="h-[max(0.75rem,env(safe-area-inset-bottom,0px))]" />
      </div>
    </div>
  )
}

function SheetAction({
  label,
  active,
  disabled,
  icon,
  onClick,
}: {
  label: string
  active?: boolean
  disabled?: boolean
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
          : 'text-[var(--color-text)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
          active ? 'bg-[var(--color-accent)] text-white' : 'bg-[var(--color-panel-2)]'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium">{label}</span>
      {active && <span className="text-[10px] font-semibold uppercase tracking-wider opacity-70">On</span>}
    </button>
  )
}

function DevicePickerSection({
  title,
  devices,
  selectedDeviceId,
  onSelect,
}: {
  title: string
  devices: MediaDeviceOption[]
  selectedDeviceId: string | null
  onSelect: (deviceId: string) => void
}) {
  return (
    <div className="border-t border-[var(--color-border)] px-2 py-3">
      <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
        {title}
      </div>
      <div className="space-y-0.5">
        {devices.map((device) => {
          const selected = device.deviceId === selectedDeviceId
          return (
            <button
              key={device.deviceId}
              type="button"
              onClick={() => onSelect(device.deviceId)}
              className={`flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none hover:bg-[var(--color-panel-2)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
                selected ? 'text-[var(--color-accent-hover)]' : 'text-[var(--color-text)]'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{device.label}</span>
              {selected && <CheckIcon />}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CallControl({
  label,
  active = false,
  danger = false,
  disabled = false,
  size = 'md',
  onClick,
  children,
}: {
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  size?: 'md' | 'lg'
  onClick: () => void
  children: React.ReactNode
}) {
  const dim = size === 'lg' ? 'h-12 w-12' : 'h-11 w-11'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex ${dim} shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-[transform,background-color] duration-150 ease-out active:scale-95 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:active:scale-100 ${
        danger
          ? 'bg-red-500/25 text-red-300 hover:bg-red-500/35'
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

function MoreCallIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
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

function CaptionsIcon({ compact = false }: { compact?: boolean }) {
  const size = compact ? 14 : 18
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
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 11h2M13 11h4M7 15h4M15 15h2" />
    </svg>
  )
}

function HandIcon({ compact = false }: { compact?: boolean }) {
  const size = compact ? 14 : 18
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
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
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

function NoiseSuppressionIcon({ off }: { off: boolean }) {
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
      <path d="M2 12h2l2-6 4 16 4-13 2 3h6" />
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

// Person silhouette on a dotted (blurred) backdrop; slashed when blur is off.
function BlurIcon({ off }: { off: boolean }) {
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
      <circle cx="12" cy="8" r="3.2" />
      <path d="M6 20a6 6 0 0 1 12 0" />
      <path d="M3.5 5h0M7 3.5h0M12 3h0M17 3.5h0M20.5 5h0M21.5 9.5h0M21.5 14.5h0M2.5 9.5h0M2.5 14.5h0" />
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
