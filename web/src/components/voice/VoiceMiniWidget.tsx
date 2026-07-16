import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { channelLabel } from '../../lib/util'
import { useStore } from '../../store'
import { Avatar } from '../Avatar'

const CORNER_KEY = 'sharp.voiceWidgetCorner'
const EDGE_MARGIN = 16
const DRAG_THRESHOLD = 5

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
type Position = { left: number; top: number }
type MiniParticipant = { userId: string; speaking: boolean }

type DragState = {
  pointerId: number
  originX: number
  originY: number
  startLeft: number
  startTop: number
  maxDistance: number
}

function storedCorner(): Corner {
  const value = window.localStorage.getItem(CORNER_KEY)
  return value === 'top-left' ||
    value === 'top-right' ||
    value === 'bottom-left' ||
    value === 'bottom-right'
    ? value
    : 'bottom-right'
}

function cornerPosition(corner: Corner, width: number, height: number): Position {
  return {
    left: corner.endsWith('right')
      ? Math.max(EDGE_MARGIN, window.innerWidth - width - EDGE_MARGIN)
      : EDGE_MARGIN,
    top: corner.startsWith('bottom')
      ? Math.max(EDGE_MARGIN, window.innerHeight - height - EDGE_MARGIN)
      : EDGE_MARGIN,
  }
}

export function VoiceMiniWidget() {
  const channelId = useStore((s) => s.voice.channelId)
  const room = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const speaking = useStore((s) => s.voice.speaking)
  const muted = useStore((s) => s.voice.muted)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const channel = useStore((s) =>
    s.channels.find((candidate) => candidate.id === channelId),
  )
  const toggleVoiceMute = useStore((s) => s.toggleVoiceMute)
  const leaveVoice = useStore((s) => s.leaveVoice)
  const setVoiceStageMode = useStore((s) => s.setVoiceStageMode)
  const cardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [corner, setCorner] = useState<Corner>(storedCorner)
  const [position, setPosition] = useState<Position | null>(null)
  const [dragging, setDragging] = useState(false)

  const participants = useMemo(() => {
    const byUser = new Map<string, MiniParticipant>()
    for (const [connId, entry] of Object.entries(room ?? {})) {
      const existing = byUser.get(entry.user_id)
      if (existing) {
        existing.speaking = existing.speaking || Boolean(speaking[connId])
      } else {
        byUser.set(entry.user_id, {
          userId: entry.user_id,
          speaking: Boolean(speaking[connId]),
        })
      }
    }
    return [...byUser.values()]
  }, [room, speaking])

  const anyScreen = useMemo(
    () => Object.values(room ?? {}).some((entry) => entry.screen_on),
    [room],
  )

  const roomName = channel
    ? channel.kind === 'dm'
      ? channel.dm_user?.display_name ?? channelLabel(channel)
      : `# ${channel.name}`
    : 'Call'

  const placeAtCorner = useCallback((nextCorner: Corner) => {
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    setPosition(cornerPosition(nextCorner, rect.width, rect.height))
  }, [])

  useLayoutEffect(() => {
    placeAtCorner(corner)
  }, [corner, participants.length, placeAtCorner])

  useEffect(() => {
    const onResize = () => placeAtCorner(corner)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [corner, placeAtCorner])

  if (!channelId) return null

  const expandCall = () => setVoiceStageMode('expanded')

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      maxDistance: 0,
    }
    setPosition({ left: rect.left, top: rect.top })
    setDragging(true)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.originX
    const dy = event.clientY - drag.originY
    drag.maxDistance = Math.max(drag.maxDistance, Math.hypot(dx, dy))
    setPosition({ left: drag.startLeft + dx, top: drag.startTop + dy })
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>, allowClick: boolean) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const distance = Math.max(
      drag.maxDistance,
      Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY),
    )
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)

    if (distance < DRAG_THRESHOLD && allowClick) {
      expandCall()
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const horizontal = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right'
    const vertical = rect.top + rect.height / 2 < window.innerHeight / 2 ? 'top' : 'bottom'
    const nextCorner = `${vertical}-${horizontal}` as Corner
    setCorner(nextCorner)
    setPosition(cornerPosition(nextCorner, rect.width, rect.height))
    window.localStorage.setItem(CORNER_KEY, nextCorner)
  }

  const visibleParticipants = participants.length > 3 ? participants.slice(0, 2) : participants
  const hiddenCount = participants.length > 3 ? participants.length - 2 : 0

  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      aria-label={`Ongoing call in ${roomName} — expand`}
      title={`Ongoing call in ${roomName}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          expandCall()
        }
      }}
      onClick={(event) => {
        if (event.detail === 0) expandCall()
      }}
      className={`fixed z-50 flex w-[88px] touch-none select-none flex-col items-center gap-2.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2.5 shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
        dragging
          ? 'cursor-grabbing'
          : 'cursor-grab transition-[left,top] duration-200 ease-out motion-reduce:transition-none'
      }`}
      style={position ?? { right: EDGE_MARGIN, bottom: EDGE_MARGIN }}
    >
      <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
        <WaveformIcon />
        <span
          className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-[var(--color-panel)] bg-[#4fbf9f]"
          aria-label="Connected"
        />
        {anyScreen && (
          <span
            className="absolute -bottom-0.5 -left-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-[var(--color-panel)] bg-[var(--color-accent)] text-white"
            aria-label="Someone is sharing their screen"
            title="Someone is sharing their screen"
          >
            <MonitorIcon />
          </span>
        )}
      </div>

      <div className="flex flex-col items-center -space-y-2" aria-label="Call participants">
        {visibleParticipants.map((participant) => {
          const name =
            users[participant.userId]?.display_name ??
            (me?.id === participant.userId ? me.display_name : 'Participant')
          return (
            <div
              key={participant.userId}
              className={`rounded-[11px] border-2 border-[var(--color-panel)] ${
                participant.speaking ? 'ring-2 ring-[#4fbf9f]' : ''
              }`}
              title={name}
            >
              <Avatar id={participant.userId} name={name} size={34} />
            </div>
          )
        })}
        {hiddenCount > 0 && (
          <div className="flex h-[38px] w-[38px] items-center justify-center rounded-full border-2 border-[var(--color-panel)] bg-[var(--color-panel-2)] text-xs font-semibold text-[var(--color-text-dim)]">
            +{hiddenCount}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1 rounded-full bg-[var(--color-panel-2)] p-1">
        <button
          type="button"
          aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          title={muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={muted}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            toggleVoiceMute()
          }}
          className={`flex h-7 w-7 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
            muted
              ? 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
              : 'text-[var(--color-text)] hover:bg-[var(--color-border)]'
          }`}
        >
          <MicIcon off={muted} />
        </button>
        <button
          type="button"
          aria-label="Leave call"
          title="Leave call"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            leaveVoice()
          }}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-red-500/20 text-red-300 outline-none hover:bg-red-500/30 focus-visible:ring-2 focus-visible:ring-red-300"
        >
          <LeaveIcon />
        </button>
      </div>
    </div>
  )
}

function WaveformIcon() {
  return (
    <svg
      width="23"
      height="23"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M5 10v4" />
      <path d="M9 7v10" />
      <path d="M13 4v16" />
      <path d="M17 8v8" />
      <path d="M21 10v4" />
    </svg>
  )
}

function MonitorIcon() {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
      <path d="M12 17v4" />
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
