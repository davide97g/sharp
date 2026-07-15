import { useMemo } from 'react'
import { useStore } from '../../store'
import { channelLabel } from '../../lib/util'
import { Avatar } from '../Avatar'

type Participant = {
  userId: string
  connIds: string[]
  muted: boolean
  speaking: boolean
  cameraOn: boolean
}

export function VoiceBar({ compact = false }: { compact?: boolean }) {
  const channelId = useStore((s) => s.voice.channelId)
  const status = useStore((s) => s.voice.status)
  const muted = useStore((s) => s.voice.muted)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const expanded = useStore((s) => s.voice.expanded)
  const speaking = useStore((s) => s.voice.speaking)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const setVoiceExpanded = useStore((s) => s.setVoiceExpanded)
  const leaveVoice = useStore((s) => s.leaveVoice)

  const participants = useMemo(() => {
    const byUser = new Map<string, Participant>()
    for (const [connId, entry] of Object.entries(room ?? {})) {
      const existing = byUser.get(entry.user_id)
      if (existing) {
        existing.connIds.push(connId)
        existing.muted = existing.muted && entry.muted
        existing.speaking = existing.speaking || Boolean(speaking[connId])
        existing.cameraOn = existing.cameraOn || entry.camera_on
      } else {
        byUser.set(entry.user_id, {
          userId: entry.user_id,
          connIds: [connId],
          muted: entry.muted,
          speaking: Boolean(speaking[connId]),
          cameraOn: entry.camera_on,
        })
      }
    }
    return [...byUser.values()]
  }, [room, speaking])

  if (!channelId) return null

  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : channel.name
    : 'Voice room'
  const statusLabel = status === 'connected' ? 'Connected' : 'Connecting'

  if (compact) {
    return (
      <section
        aria-label={`Voice room: ${roomName}`}
        title={`${roomName} — ${statusLabel}`}
        className="absolute bottom-[4.5rem] left-2 right-2 z-20 flex flex-col items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-ink)] px-1.5 py-2 shadow-xl"
      >
        <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <VoiceIcon />
          <span
            className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--color-ink)] ${
              status === 'connected' ? 'bg-[#4fbf9f]' : 'animate-pulse bg-[var(--color-text-faint)]'
            }`}
          />
        </span>
        <span className="sr-only">{roomName}, {statusLabel}</span>
        {participants.length > 0 && (
          <ul aria-label={`${participants.length} participants`} className="flex -space-x-1.5">
            {participants.slice(0, 2).map((participant) => (
              <ParticipantAvatar
                key={participant.userId}
                participant={participant}
                name={participantName(participant.userId, users, me)}
                size={22}
              />
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-1">
          <VoiceControl
            label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
            active={cameraStatus !== 'off'}
            disabled={status !== 'connected' || cameraStatus === 'starting'}
            onClick={toggleVoiceCamera}
          >
            <CameraIcon off={cameraStatus === 'off'} />
          </VoiceControl>
          <VoiceControl
            label={expanded ? 'Collapse call stage' : 'Expand call stage'}
            active={expanded}
            onClick={() => setVoiceExpanded(!expanded)}
          >
            <ExpandIcon expanded={expanded} />
          </VoiceControl>
          <VoiceControl
            label={muted ? 'Unmute microphone' : 'Mute microphone'}
            active={muted}
            onClick={toggleVoiceMute}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </VoiceControl>
          <VoiceControl label="Leave voice room" danger onClick={leaveVoice}>
            <LeaveIcon />
          </VoiceControl>
        </div>
      </section>
    )
  }

  return (
    <section
      aria-label={`Voice room: ${roomName}`}
      className="absolute bottom-[4.5rem] left-2 right-2 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-ink)] p-2.5 shadow-xl"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <VoiceIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {channel?.kind === 'dm' ? roomName : `# ${roomName}`}
          </div>
          <div
            role="status"
            className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status === 'connected' ? 'bg-[#4fbf9f]' : 'animate-pulse bg-[var(--color-text-faint)]'
              }`}
            />
            {statusLabel}
          </div>
        </div>
        <div className="flex gap-1">
          <VoiceControl
            label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
            active={cameraStatus !== 'off'}
            disabled={status !== 'connected' || cameraStatus === 'starting'}
            onClick={toggleVoiceCamera}
          >
            <CameraIcon off={cameraStatus === 'off'} />
          </VoiceControl>
          <VoiceControl
            label={expanded ? 'Collapse call stage' : 'Expand call stage'}
            active={expanded}
            onClick={() => setVoiceExpanded(!expanded)}
          >
            <ExpandIcon expanded={expanded} />
          </VoiceControl>
          <VoiceControl
            label={muted ? 'Unmute microphone' : 'Mute microphone'}
            active={muted}
            onClick={toggleVoiceMute}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </VoiceControl>
          <VoiceControl label="Leave voice room" danger onClick={leaveVoice}>
            <LeaveIcon />
          </VoiceControl>
        </div>
      </div>

      <div className="mt-2 border-t border-[var(--color-border-soft)] pt-2">
        {participants.length > 0 ? (
          <ul
            aria-label={`${participants.length} ${participants.length === 1 ? 'participant' : 'participants'}`}
            className="flex flex-wrap items-center gap-1.5"
          >
            {participants.map((participant) => (
              <ParticipantAvatar
                key={participant.userId}
                participant={participant}
                name={participantName(participant.userId, users, me)}
                size={28}
              />
            ))}
          </ul>
        ) : (
          <span className="text-[11px] text-[var(--color-text-faint)]">
            Waiting for participants…
          </span>
        )}
      </div>
    </section>
  )
}

function participantName(
  userId: string,
  users: ReturnType<typeof useStore.getState>['users'],
  me: ReturnType<typeof useStore.getState>['me'],
) {
  return users[userId]?.display_name ?? (me?.id === userId ? me.display_name : 'Participant')
}

function ParticipantAvatar({
  participant,
  name,
  size,
}: {
  participant: Participant
  name: string
  size: number
}) {
  const state = [
    participant.speaking ? 'speaking' : '',
    participant.muted ? 'muted' : '',
    participant.cameraOn ? 'camera on' : '',
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <li
      aria-label={`${name}${state ? `, ${state}` : ''}`}
      title={`${name}${state ? ` — ${state}` : ''}`}
      className={`relative rounded-[9px] ${
        participant.speaking ? 'ring-2 ring-[#4fbf9f] ring-offset-1 ring-offset-[var(--color-ink)]' : ''
      }`}
    >
      <Avatar id={participant.userId} name={name} size={size} />
      {participant.muted && (
        <span className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-[var(--color-ink)] bg-[var(--color-panel-2)] text-[var(--color-text-dim)]">
          <MicOffIcon size={9} />
        </span>
      )}
    </li>
  )
}

function VoiceControl({
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
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
        danger
          ? 'text-[var(--color-text-dim)] hover:bg-red-500/15 hover:text-red-300'
          : active
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
            : 'bg-[var(--color-panel)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}

function CameraIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m16 13 5 3V8l-5 3" />
      <rect x="3" y="6" width="13" height="12" rx="2" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {expanded ? (
        <>
          <path d="M8 3v5H3" />
          <path d="m3 8 5-5" />
          <path d="M16 21v-5h5" />
          <path d="m21 16-5 5" />
        </>
      ) : (
        <>
          <path d="M15 3h6v6" />
          <path d="m21 3-7 7" />
          <path d="M9 21H3v-6" />
          <path d="m3 21 7-7" />
        </>
      )}
    </svg>
  )
}

function VoiceIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 10v4" />
      <path d="M7 7v10" />
      <path d="M11 4v16" />
      <path d="M15 8v8" />
      <path d="M19 10v4" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
    </svg>
  )
}

function MicOffIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m2 2 20 20" />
      <path d="M9 9v1a3 3 0 0 0 5.1 2.1" />
      <path d="M15 9.3V5a3 3 0 0 0-5.6-1.5" />
      <path d="M5 10a7 7 0 0 0 12 4.9" />
      <path d="M19 10a7 7 0 0 1-.3 2" />
      <path d="M12 17v5" />
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 17 5 12l5-5" />
      <path d="M5 12h12" />
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </svg>
  )
}
