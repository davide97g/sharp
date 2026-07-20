import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { channelLabel } from '../../lib/util'
import {
  closeElementPip,
  copyDocumentStyles,
  openElementPip,
  supportsDocumentPip,
  supportsElementPip,
} from '../../lib/pip'
import { useStore } from '../../store'
import { Avatar } from '../Avatar'
import { MicActivityIcon } from './MicActivityIcon'

type PipParticipant = {
  userId: string
  muted: boolean
  speaking: boolean
  handRaised: boolean
  handRaisedAt: number | null
  cameraConnId: string | null
}

type PipScreenShare = {
  userId: string
  displayName: string
  local: boolean
  stream: MediaStream | null
}

export type VoicePipController = {
  supported: boolean
  open: () => Promise<void>
  closeAndFocus: () => void
  pipWindow: Window | null
  portal: React.ReactPortal | null
}

export function useVoicePip(hasFallbackVideo: boolean): VoicePipController {
  const status = useStore((s) => s.voice.status)
  const muted = useStore((s) => s.voice.muted)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const pipWindowRef = useRef<Window | null>(null)
  const pageHideRef = useRef<(() => void) | null>(null)
  const [pipWindow, setPipWindow] = useState<Window | null>(null)
  const documentPipSupported = supportsDocumentPip()
  const supported = documentPipSupported || (hasFallbackVideo && supportsElementPip())

  const close = useCallback(() => {
    const current = pipWindowRef.current
    const onPageHide = pageHideRef.current
    pipWindowRef.current = null
    pageHideRef.current = null
    setPipWindow(null)
    if (current) {
      if (onPageHide) current.removeEventListener('pagehide', onPageHide)
      if (!current.closed) current.close()
    }
    closeElementPip()
  }, [])

  const closeAndFocus = useCallback(() => {
    close()
    window.focus()
  }, [close])

  const open = useCallback(async () => {
    const existing = pipWindowRef.current
    if (existing && !existing.closed) {
      existing.focus()
      return
    }

    if (!supportsDocumentPip()) {
      try {
        await openElementPip()
      } catch {
        // Browser owns element PiP errors (permission, gesture, or another PiP window).
      }
      return
    }

    try {
      const next = await window.documentPictureInPicture!.requestWindow({
        width: 360,
        height: 280,
      })
      next.document.title = 'Sharp call'
      copyDocumentStyles(next)

      const onPageHide = () => {
        if (pipWindowRef.current !== next) return
        pipWindowRef.current = null
        pageHideRef.current = null
        setPipWindow(null)
      }
      pipWindowRef.current = next
      pageHideRef.current = onPageHide
      next.addEventListener('pagehide', onPageHide, { once: true })
      setPipWindow(next)
    } catch {
      // Permission denial leaves the in-page stage available.
    }
  }, [])

  useEffect(() => close, [close])

  useEffect(() => {
    if (status !== 'connected') close()
  }, [close, status])

  useEffect(() => {
    if (status !== 'connected' || !documentPipSupported || !navigator.mediaSession) return
    try {
      navigator.mediaSession.setActionHandler(
        'enterpictureinpicture' as MediaSessionAction,
        () => void open(),
      )
    } catch {
      return
    }
    return () => {
      try {
        navigator.mediaSession.setActionHandler(
          'enterpictureinpicture' as MediaSessionAction,
          null,
        )
      } catch {
        // Older browsers reject unknown Media Session actions.
      }
    }
  }, [documentPipSupported, open, status])

  useEffect(() => {
    if (status !== 'connected' || !navigator.mediaSession) return
    try {
      void navigator.mediaSession.setMicrophoneActive(!muted).catch(() => {})
    } catch {
      // Media conferencing state is optional.
    }
    try {
      void navigator.mediaSession.setCameraActive(cameraStatus === 'on').catch(() => {})
    } catch {
      // Media conferencing state is optional.
    }
  }, [cameraStatus, muted, status])

  useEffect(() => {
    if (status !== 'connected' || !navigator.mediaSession) return
    return () => {
      try {
        void navigator.mediaSession.setMicrophoneActive(false).catch(() => {})
      } catch {
        // Media conferencing state is optional.
      }
      try {
        void navigator.mediaSession.setCameraActive(false).catch(() => {})
      } catch {
        // Media conferencing state is optional.
      }
    }
  }, [status])

  return {
    supported,
    open,
    closeAndFocus,
    pipWindow,
    portal: pipWindow
      ? createPortal(<PipStage onReturn={closeAndFocus} />, pipWindow.document.body)
      : null,
  }
}

function PipStage({ onReturn }: { onReturn: () => void }) {
  const channelId = useStore((s) => s.voice.channelId)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const speaking = useStore((s) => s.voice.speaking)
  const muted = useStore((s) => s.voice.muted)
  const handRaised = useStore((s) => s.voice.handRaised)
  const cameraStatus = useStore((s) => s.voice.cameraStatus)
  const videoBackground = useStore((s) => s.voice.videoBackground)
  const localStream = useStore((s) => s.voice.localStream)
  const remoteStreams = useStore((s) => s.voice.remoteStreams)
  const localScreenStream = useStore((s) => s.voice.localScreenStream)
  const remoteScreenStreams = useStore((s) => s.voice.remoteScreenStreams)
  const myConnId = useStore((s) => s.myConnId)
  const me = useStore((s) => s.me)
  const users = useStore((s) => s.users)
  const channel = useStore((s) =>
    s.channels.find((candidate) => candidate.id === channelId),
  )
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const toggleVoiceHand = useStore((s) => s.toggleVoiceHand)
  const toggleVoiceCamera = useStore((s) => s.toggleVoiceCamera)
  const setVoiceVideoBackground = useStore((s) => s.setVoiceVideoBackground)
  const leaveVoice = useStore((s) => s.leaveVoice)

  const participants = useMemo(() => {
    const byUser = new Map<string, PipParticipant>()
    for (const [connId, entry] of Object.entries(room ?? {})) {
      const existing = byUser.get(entry.user_id)
      if (existing) {
        existing.muted = existing.muted && entry.muted
        existing.speaking = existing.speaking || Boolean(speaking[connId])
        if (entry.hand_raised) {
          existing.handRaised = true
          existing.handRaisedAt =
            existing.handRaisedAt === null
              ? entry.hand_raised_at
              : entry.hand_raised_at === null
                ? existing.handRaisedAt
                : Math.min(existing.handRaisedAt, entry.hand_raised_at)
        }
        if (entry.camera_on && (!existing.cameraConnId || connId === myConnId)) {
          existing.cameraConnId = connId
        }
      } else {
        byUser.set(entry.user_id, {
          userId: entry.user_id,
          muted: entry.muted,
          speaking: Boolean(speaking[connId]),
          handRaised: entry.hand_raised,
          handRaisedAt: entry.hand_raised ? entry.hand_raised_at : null,
          cameraConnId: entry.camera_on ? connId : null,
        })
      }
    }
    // Raised hands first (oldest raise first); others keep insertion order.
    return [...byUser.values()].sort((a, b) => {
      if (a.handRaised !== b.handRaised) return a.handRaised ? -1 : 1
      if (a.handRaised && b.handRaised) return (a.handRaisedAt ?? 0) - (b.handRaisedAt ?? 0)
      return 0
    })
  }, [myConnId, room, speaking])

  // First active screen share wins (server caps shares at one per room anyway).
  const screenShare = useMemo<PipScreenShare | null>(() => {
    for (const [connId, entry] of Object.entries(room ?? {})) {
      if (!entry.screen_on) continue
      const local = connId === myConnId
      return {
        userId: entry.user_id,
        displayName: entry.display_name,
        local,
        stream: local ? localScreenStream : remoteScreenStreams[connId] ?? null,
      }
    }
    return null
  }, [room, myConnId, localScreenStream, remoteScreenStreams])

  const resolveName = (userId: string, fallback?: string) =>
    users[userId]?.display_name ??
    (me?.id === userId ? me.display_name : undefined) ??
    fallback ??
    'Participant'

  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Call'

  return (
    <main className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-ink)] text-[var(--color-text)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-2.5">
        <div className="min-w-0 flex-1 truncate text-xs font-semibold">{roomName}</div>
        <button
          type="button"
          aria-label="Return to call"
          title="Return to call"
          onClick={onReturn}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <ReturnIcon />
        </button>
      </header>

      {screenShare ? (
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 p-1.5">
          <PipScreenTile
            name={resolveName(screenShare.userId, screenShare.displayName)}
            stream={screenShare.stream}
            local={screenShare.local}
          />
          {participants.length > 0 && (
            <div
              aria-label="Call participants"
              className="flex shrink-0 items-center gap-1.5 overflow-x-auto"
            >
              {participants.map((participant) => {
                const name = resolveName(participant.userId)
                return (
                  <div
                    key={participant.userId}
                    title={name}
                    className={`shrink-0 rounded-full ${
                      participant.speaking ? 'ring-2 ring-[#4fbf9f]' : ''
                    }`}
                  >
                    <Avatar id={participant.userId} name={name} size={28} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : (
        <div className={`grid min-h-0 flex-1 auto-rows-fr gap-1.5 p-1.5 ${
          participants.length <= 1 ? 'grid-cols-1' : 'grid-cols-2'
        }`}>
          {participants.map((participant) => {
            const local = participant.cameraConnId === myConnId
            const stream = local
              ? localStream
              : participant.cameraConnId
                ? remoteStreams[participant.cameraConnId]
                : null
            return (
              <PipTile
                key={participant.userId}
                userId={participant.userId}
                name={resolveName(participant.userId)}
                stream={stream}
                local={local}
                muted={participant.muted}
                speaking={participant.speaking}
                handRaised={participant.handRaised}
              />
            )
          })}
        </div>
      )}

      <footer className="flex shrink-0 items-center justify-center gap-2 border-t border-[var(--color-border)] px-2 py-1.5">
        <PipControl
          label={muted ? 'Unmute microphone' : 'Mute microphone'}
          active={!muted}
          onClick={toggleVoiceMute}
        >
          <MicActivityIcon muted={muted} size={15} />
        </PipControl>
        <PipControl
          label={handRaised ? 'Lower hand' : 'Raise hand'}
          active={handRaised}
          onClick={toggleVoiceHand}
        >
          <HandIcon />
        </PipControl>
        <PipControl
          label={cameraStatus === 'on' ? 'Turn camera off' : 'Turn camera on'}
          active={cameraStatus !== 'off'}
          disabled={cameraStatus === 'starting'}
          onClick={toggleVoiceCamera}
        >
          <CameraIcon off={cameraStatus === 'off'} />
        </PipControl>
        <PipControl
          label={
            videoBackground.id === 'none' ? 'Blur my background' : 'Turn off camera background'
          }
          active={videoBackground.id !== 'none'}
          onClick={() =>
            void setVoiceVideoBackground({
              id: videoBackground.id === 'none' ? 'blur' : 'none',
            })
          }
        >
          <BlurIcon off={videoBackground.id === 'none'} />
        </PipControl>
        <PipControl label="Leave call" danger onClick={leaveVoice}>
          <LeaveIcon />
        </PipControl>
      </footer>
    </main>
  )
}

function PipTile({
  userId,
  name,
  stream,
  local,
  muted,
  speaking,
  handRaised,
}: {
  userId: string
  name: string
  stream: MediaStream | null
  local: boolean
  muted: boolean
  speaking: boolean
  handRaised: boolean
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
      className={`relative flex min-h-0 overflow-hidden rounded-xl border bg-[var(--color-panel)] ${
        speaking ? 'border-[#4fbf9f] ring-2 ring-[#4fbf9f]/30' : 'border-[var(--color-border)]'
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`h-full w-full object-cover ${local ? '-scale-x-100' : ''}`}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_top,var(--color-panel-2),var(--color-panel))]">
          <Avatar id={userId} name={name} size={44} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5 text-[11px] font-medium text-white">
        <span className="truncate">
          {name}{local ? ' (you)' : ''}
        </span>
        {(handRaised || muted) && (
          <span className="ml-auto flex items-center gap-1">
            {handRaised && (
              <span
                className="rounded-full bg-amber-400/90 p-1 text-[#3a2a00]"
                title="Hand raised"
              >
                <HandIcon />
              </span>
            )}
            {muted && (
              <span className="rounded-full bg-black/50 p-1" title="Muted">
                <MicIcon off />
              </span>
            )}
          </span>
        )}
      </div>
    </article>
  )
}

function PipScreenTile({
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
    <article className="relative flex min-h-0 flex-1 overflow-hidden rounded-xl border border-[var(--color-border)] bg-black">
      {hasVideo ? (
        // Never mirrored; muted — remote system/tab audio plays via the engine's
        // hidden screenAudio element.
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-contain"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-[11px] text-[var(--color-text-dim)]">
          Waiting for screen…
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/80 to-transparent px-2 pb-1.5 pt-5 text-[11px] font-medium text-white">
        <span className="truncate">{local ? 'Your screen' : `${name}'s screen`}</span>
      </div>
    </article>
  )
}

function PipControl({
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
      className={`flex h-9 w-9 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
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

function ReturnIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 14-4-4 4-4" />
      <path d="M5 10h9a5 5 0 0 1 5 5v3" />
    </svg>
  )
}

function HandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 11V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2 2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </svg>
  )
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
      {off && <path d="m3 3 18 18" />}
    </svg>
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

function BlurIcon({ off }: { off: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M6 20a6 6 0 0 1 12 0" />
      <path d="M3.5 5h0M7 3.5h0M12 3h0M17 3.5h0M20.5 5h0M21.5 9.5h0M21.5 14.5h0M2.5 9.5h0M2.5 14.5h0" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}

function LeaveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 17 5 12l5-5" />
      <path d="M5 12h12" />
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
    </svg>
  )
}
