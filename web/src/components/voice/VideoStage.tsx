import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import { Avatar } from '../Avatar'

type StageParticipant = {
  userId: string
  connIds: string[]
  muted: boolean
  speaking: boolean
  cameraConnId: string | null
}

export function VideoStage() {
  const channelId = useStore((s) => s.voice.channelId)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const speaking = useStore((s) => s.voice.speaking)
  const muted = useStore((s) => s.voice.muted)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const myConnId = useStore((s) => s.myConnId)
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channel = useStore((s) => s.channels.find((candidate) => candidate.id === channelId))
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const setVoiceExpanded = useStore((s) => s.setVoiceExpanded)
  const leaveVoice = useStore((s) => s.leaveVoice)

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
  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Call'

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]" aria-label={`${roomName} video call`}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{roomName}</div>
          <div className="text-xs text-[var(--color-text-faint)]">
            {participants.length} {participants.length === 1 ? 'participant' : 'participants'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setVoiceExpanded(false)}
          className="rounded-lg bg-[var(--color-panel)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          Collapse
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto grid h-full max-w-6xl auto-rows-fr grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
              />
            )
          })}
        </div>
      </div>

      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--color-border)] bg-[var(--color-ink)] px-4 py-3">
        <CallControl
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          active={muted}
          onClick={toggleVoiceMute}
        >
          <MicIcon off={muted} />
        </CallControl>
        <CallControl
          label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
          active={cameraStatus !== 'off'}
          disabled={cameraStatus === 'starting'}
          onClick={toggleVoiceCamera}
        >
          <CameraIcon off={cameraStatus === 'off'} />
        </CallControl>
        <CallControl label="Leave call" danger onClick={leaveVoice}>
          <LeaveIcon />
        </CallControl>
      </footer>
    </main>
  )
}

function VideoTile({
  userId,
  name,
  stream,
  local,
  muted,
  speaking,
}: {
  userId: string
  name: string
  stream: MediaStream | null
  local: boolean
  muted: boolean
  speaking: boolean
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
      className={`relative flex min-h-48 overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${
        speaking ? 'border-[#4fbf9f] ring-2 ring-[#4fbf9f]/30' : 'border-[var(--color-border)]'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full min-h-48 w-full object-cover ${local ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div className="flex min-h-48 w-full items-center justify-center bg-[radial-gradient(circle_at_top,var(--color-panel-2),var(--color-panel))]">
          <Avatar id={userId} name={name} size={72} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/75 to-transparent px-3 pb-3 pt-8 text-sm font-medium text-white">
        <span className="truncate">{name}{local ? ' (you)' : ''}</span>
        {muted && <span className="ml-auto rounded-full bg-black/45 p-1" title="Muted"><MicIcon off /></span>}
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

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m16 13 5 3V8l-5 3" />
      <rect x="3" y="6" width="13" height="12" rx="2" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 17 5 12l5-5" />
      <path d="M5 12h12" />
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </svg>
  )
}
