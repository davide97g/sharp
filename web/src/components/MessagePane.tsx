import { effectiveNicknames } from '../lib/displayName'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store'
import { MessageItem } from './MessageItem'
import { DayDivider } from './DayDivider'
import { Composer } from './Composer'
import { TypingRow } from './TypingRow'
import { ChannelSettingsModal } from './ChannelSettingsModal'
import { ChatLayoutChooser } from './ChatLayoutChooser'
import { InboxTrigger } from './NotificationCenter'
import { ChannelTabs } from './ChannelTabs'
import { Avatar } from './Avatar'
import { UserChip } from './UserCard'
import { GearIcon, LockIcon } from './icons'
import { DuckSuggest } from './DuckSuggest'
import { ScheduleMeetingModal } from './calendar/ScheduleMeetingModal'
import { ActivePollBanner } from './ActivePollBanner'
import { StreamShield } from './stream/StreamShield'
import { useIsMobile } from '../lib/useMediaQuery'
import { channelLabel, sameDay, withinMinutes } from '../lib/util'

export function MessagePane() {
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const me = useStore((s) => s.me)
  const nicknames = useStore(effectiveNicknames)
  const channels = useStore((s) => s.channels)
  const channel = channels.find((c) => c.id === channelId)
  const cm = useStore((s) => (channelId ? s.byChannel[channelId] : undefined))
  const online = useStore((s) => s.online)
  const setCurrentChannel = useStore((s) => s.setCurrentChannel)
  const loadMessages = useStore((s) => s.loadMessages)
  const loadOlder = useStore((s) => s.loadOlder)
  const markRead = useStore((s) => s.markRead)
  const markChannelNotifsRead = useStore((s) => s.markChannelNotifsRead)
  const activeVoiceChannelId = useStore((s) => s.voice.channelId)
  const voiceStatus = useStore((s) => s.voice.status)
  const voiceRoom = useStore((s) => (channelId ? s.voiceRooms[channelId] : undefined))
  const joinVoice = useStore((s) => s.joinVoice)
  const leaveVoice = useStore((s) => s.leaveVoice)
  const chatLayout = useStore((s) => s.chatLayout)
  const dmEncryption = useStore((s) => (channelId ? s.dmEncryption[channelId] : undefined))
  const dmPartnerReady = useStore((s) => (channelId ? s.dmPartnerReady[channelId] : undefined))
  const focus = useStore((s) => s.focus)
  const setFocus = useStore((s) => s.setFocus)
  const [showSettings, setShowSettings] = useState(false)
  const [showSchedule, setShowSchedule] = useState(false)
  const focusTriesRef = useRef(0)
  const focusedOnceRef = useRef<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const pendingRestoreRef = useRef<number | null>(null)
  const prevTailRef = useRef<string | null>(null)
  const prevLoadedRef = useRef(false)
  const prevChannelRef = useRef<string | undefined>(undefined)
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialUnreadRef = useRef(0)
  const unreadGateRef = useRef(false)
  const leftBottomSinceUnreadRef = useRef(false)
  const programmaticBottomRef = useRef(false)
  const trackedTailRef = useRef<string | null>(null)
  const trackedChannelRef = useRef<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [pendingJump, setPendingJump] = useState<{ targetId: string; count: number } | null>(null)

  // Ref initialization happens during render so no scroll event can race the
  // unread gate between commit and the first layout effect.
  if (channel && trackedChannelRef.current !== channel.id) {
    const unread = Math.max(0, channel.unread_count)
    initialUnreadRef.current = unread
    unreadGateRef.current = unread > 0
    leftBottomSinceUnreadRef.current = false
    trackedTailRef.current = null
    trackedChannelRef.current = channel.id
    atBottomRef.current = true
  }

  // set current channel + load
  useEffect(() => {
    if (!channelId) return
    setCurrentChannel(channelId)
    const st = useStore.getState().byChannel[channelId]
    if (!st?.loaded && !st?.loading) loadMessages(channelId)
    return () => setCurrentChannel(null)
  }, [channelId, setCurrentChannel, loadMessages])

  // Opening a channel means we've "seen" its notifications: clear this
  // channel's inbox entries while leaving unread items from other channels.
  useEffect(() => {
    if (channelId) markChannelNotifsRead(channelId)
  }, [channelId, markChannelNotifsRead])

  // Keyboard shortcuts acting on the hovered message (e: react, r: reply,
  // t: thread; Esc: cancel). Disabled while typing in an input/textarea.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (t?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      const st = useStore.getState()
      const cid = st.currentChannelId
      if (e.key === 'Escape') {
        if (st.paletteForMessageId) {
          st.setPaletteFor(null)
          e.preventDefault()
        } else if (cid && st.replyTargets[cid]) {
          st.setReplyTarget(cid, null)
          e.preventDefault()
        }
        return
      }

      const key = e.key.toLowerCase()
      if (key !== 'e' && key !== 'r' && key !== 't') return
      const id = st.activeMessageId
      const msg = id && cid ? st.byChannel[cid]?.list.find((m) => m.id === id) : undefined
      if (!msg || msg.deleted_at) return
      e.preventDefault()
      if (key === 'e') {
        st.setPaletteFor(msg.id)
      } else if (key === 'r') {
        st.setReplyTarget(msg.channel_id, msg)
        st.requestComposerFocus(`c:${msg.channel_id}`)
      } else if (key === 't') {
        const parent = msg.parent_id ?? msg.id
        st.openThread(parent)
        st.requestComposerFocus(`t:${parent}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const messages = cm?.list ?? []
  const lastId = messages.length ? messages[messages.length - 1].id : null

  // Reset visual state for the route. Unread refs were captured synchronously
  // above; append-only tracking catches messages received in older history.
  useLayoutEffect(() => {
    setAtBottom(true)
    setPendingJump(null)
  }, [channelId])

  useEffect(() => {
    if (!channelId || !cm?.loaded || trackedChannelRef.current !== channelId) return

    const previousTail = trackedTailRef.current
    const currentTail = messages.length ? messages[messages.length - 1].id : null

    if (previousTail === null) {
      const unread = initialUnreadRef.current
      if (unread > 0 && messages.length > 0) {
        const loadedUnread = Math.min(unread, messages.length)
        setPendingJump({
          targetId: messages[messages.length - loadedUnread].id,
          count: unread,
        })
      }
      trackedTailRef.current = currentTail
      return
    }

    const previousTailIndex = messages.findIndex((message) => message.id === previousTail)
    const appended = previousTailIndex >= 0 ? messages.slice(previousTailIndex + 1) : []
    const newFromOthers = appended.filter((message) => message.user.id !== me?.id)
    trackedTailRef.current = currentTail

    if (!atBottomRef.current && newFromOthers.length > 0) {
      setPendingJump((current) => ({
        targetId: current?.targetId ?? newFromOthers[0].id,
        count: (current?.count ?? 0) + newFromOthers.length,
      }))
    }
  }, [channelId, cm?.loaded, me?.id, messages])

  // scroll management
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const channelChanged = prevChannelRef.current !== channelId
    const tailChanged =
      !channelChanged && prevLoadedRef.current && prevTailRef.current !== lastId
    prevChannelRef.current = channelId
    prevTailRef.current = lastId
    prevLoadedRef.current = Boolean(cm?.loaded)

    if (tailChanged) {
      // New chat content should always remain visible, including GIFs sent by
      // the duck while the user is reading older messages.
      pendingRestoreRef.current = null
      unreadGateRef.current = false
      setPendingJump(null)
      programmaticBottomRef.current = true
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
      setAtBottom(true)
    } else if (pendingRestoreRef.current !== null) {
      // restore after prepending older messages
      el.scrollTop = el.scrollHeight - pendingRestoreRef.current
      pendingRestoreRef.current = null
    } else if (channelChanged || atBottomRef.current) {
      programmaticBottomRef.current = true
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
  }, [messages.length, lastId, channelId, cm?.loaded])

  // mark read when at bottom & new content
  useEffect(() => {
    if (!channelId || !lastId) return
    if (!atBottomRef.current) return
    if (unreadGateRef.current) return
    if (readTimerRef.current) clearTimeout(readTimerRef.current)
    readTimerRef.current = setTimeout(() => {
      markRead(channelId, lastId)
    }, 400)
    return () => {
      if (readTimerRef.current) clearTimeout(readTimerRef.current)
    }
  }, [channelId, lastId, markRead])

  // Land-from-search: scroll to the focused message, pulling older pages if it
  // isn't loaded yet (bounded). Runs when messages arrive or the focus changes.
  useEffect(() => {
    if (!focus) {
      focusedOnceRef.current = null
      return
    }
    if (focus.channelId !== channelId) return
    const el = document.getElementById(`msg-${focus.messageId}`)
    if (el) {
      if (focusedOnceRef.current !== focus.messageId) {
        focusedOnceRef.current = focus.messageId
        focusTriesRef.current = 0
        requestAnimationFrame(() =>
          el.scrollIntoView({ behavior: 'smooth', block: 'center' }),
        )
      }
      return
    }
    // Not in the loaded window: page backwards a bounded number of times.
    const st = useStore.getState().byChannel[channelId]
    if (st?.hasMore && !st.loading && focusTriesRef.current < 20) {
      focusTriesRef.current += 1
      loadOlder(channelId)
    } else if (!st?.loading) {
      // Reached the top (or a thread reply we can't show inline): give up quietly.
      setFocus(null)
      focusedOnceRef.current = null
    }
  }, [focus, channelId, messages.length, loadOlder, setFocus])

  // Clear the search-focus highlight on the next genuine user interaction.
  useEffect(() => {
    if (!focus || focus.channelId !== channelId) return
    let armed = false
    const t = setTimeout(() => {
      armed = true
    }, 500)
    const clear = () => {
      if (armed) setFocus(null)
    }
    window.addEventListener('pointerdown', clear)
    window.addEventListener('keydown', clear)
    window.addEventListener('wheel', clear, { passive: true })
    return () => {
      clearTimeout(t)
      window.removeEventListener('pointerdown', clear)
      window.removeEventListener('keydown', clear)
      window.removeEventListener('wheel', clear)
    }
  }, [focus, channelId, setFocus])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nextAtBottom = distanceFromBottom < 80
    atBottomRef.current = nextAtBottom
    setAtBottom((current) => (current === nextAtBottom ? current : nextAtBottom))
    if (programmaticBottomRef.current) {
      programmaticBottomRef.current = false
      if (nextAtBottom) return
    }
    if (!nextAtBottom) leftBottomSinceUnreadRef.current = true

    if (el.scrollTop < 140 && cm?.hasMore && !cm.loading && channelId) {
      pendingRestoreRef.current = el.scrollHeight - el.scrollTop
      loadOlder(channelId)
    }
    // mark read once user reaches bottom
    if (
      nextAtBottom &&
      (!unreadGateRef.current || leftBottomSinceUnreadRef.current) &&
      channelId &&
      lastId
    ) {
      unreadGateRef.current = false
      setPendingJump(null)
      markRead(channelId, lastId)
    }
  }

  function jumpToMessages() {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth'

    if (pendingJump) {
      const target = document.getElementById(`msg-${pendingJump.targetId}`)
      unreadGateRef.current = false
      setPendingJump(null)
      target?.scrollIntoView({ behavior, block: 'center' })

      if (target && !reducedMotion) {
        window.setTimeout(() => {
          target.animate(
            [
              { backgroundColor: 'color-mix(in srgb, var(--color-accent) 18%, transparent)' },
              { backgroundColor: 'transparent' },
            ],
            { duration: 900, easing: 'ease-out' },
          )
        }, 180)
      }
      return
    }

    const el = scrollRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior })
  }

  if (!channelId) return null

  if (!channel) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-dim)]">
        Channel not found.
      </div>
    )
  }

  const isDm = channel.kind === 'dm'
  const dmOnline = isDm && channel.dm_user ? online.has(channel.dm_user.id) : undefined
  const bubbles = isDm && chatLayout === 'bubble'
  const needsLayoutChoice = isDm && chatLayout === null
  const inThisVoiceRoom = activeVoiceChannelId === channel.id
  const voiceOccupancy = new Set(
    Object.values(voiceRoom ?? {}).map((participant) => participant.user_id),
  ).size
  const voiceAction = inThisVoiceRoom
    ? isDm
      ? 'Leave huddle'
      : 'Leave voice'
    : isDm
      ? 'Start huddle'
      : 'Join voice'

  const pane = (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      {/* header */}
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-3 sm:px-4">
        {isMobile && (
          <button
            type="button"
            onClick={() => navigate('/')}
            aria-label="Back to channels"
            className="-ml-1 flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <BackIcon />
          </button>
        )}
        <div className="flex min-w-0 items-center gap-2">
          {isDm ? (
            <span className="flex min-w-0 items-center gap-2 truncate font-semibold">
              {channel.dm_user && (
                <>
                  <Avatar
                    id={channel.dm_user.id}
                    name={channel.dm_user.display_name}
                    size={26}
                    online={dmOnline}
                  />
                  <UserChip
                    userId={channel.dm_user.id}
                    fallbackName={channel.dm_user.display_name}
                    className="min-w-0 truncate hover:underline"
                  >
                    {channelLabel(channel, nicknames)}
                  </UserChip>
                </>
              )}
              {!channel.dm_user && (
                <span className="truncate">{channelLabel(channel, nicknames)}</span>
              )}
              {dmEncryption === true && (
                <span className="shrink-0 text-[var(--color-text-faint)]" title="End-to-end encrypted">
                  <LockIcon />
                </span>
              )}
            </span>
          ) : (
            <button
              onClick={() => setShowSettings(true)}
              title="Channel settings"
              className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-semibold hover:bg-[var(--color-panel)]"
            >
              <span className="text-[var(--color-text-faint)]">#</span>
              <span className="truncate">{channel.name}</span>
              {channel.kind === 'private' && (
                <span className="shrink-0 text-[var(--color-text-faint)]" title="Private">
                  <LockIcon />
                </span>
              )}
            </button>
          )}
        </div>
        {channel.topic && !isMobile && (
          <>
            <span className="text-[var(--color-border)]">|</span>
            <span className="truncate text-sm text-[var(--color-text-dim)]">
              {channel.topic}
            </span>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (inThisVoiceRoom) leaveVoice()
              else void joinVoice(channel.id)
            }}
            aria-label={voiceAction}
            aria-pressed={inThisVoiceRoom}
            title={voiceAction}
            className={`voice-channel-button flex h-10 w-10 cursor-pointer items-center justify-center gap-1.5 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] sm:h-8 sm:w-auto sm:px-2 ${
              inThisVoiceRoom
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-inset ring-[var(--color-accent)]'
                : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
            }`}
            data-live={voiceOccupancy > 0 || undefined}
          >
            <VoiceIcon connecting={inThisVoiceRoom && voiceStatus === 'connecting'} />
            {voiceOccupancy > 0 && (
              <span className="hidden text-[11px] font-semibold tabular-nums sm:inline">
                {voiceOccupancy}
              </span>
            )}
          </button>
          {!isMobile && (
            <button
              type="button"
              onClick={() => setShowSchedule(true)}
              aria-label="Schedule a meeting"
              title="Schedule a meeting"
              className="flex h-10 min-w-10 cursor-pointer items-center justify-center rounded-md px-2 text-sm text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] sm:h-8 sm:min-w-0"
            >
              <ScheduleIcon />
            </button>
          )}
          <button
            onClick={() => setShowSettings(true)}
            aria-label={isDm ? 'Conversation settings' : 'Channel settings'}
            title={isDm ? 'Conversation settings' : 'Channel settings'}
            className="flex h-10 w-10 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] sm:h-8 sm:w-8"
          >
            <GearIcon />
          </button>
          <InboxTrigger variant="header" />
        </div>
      </header>

      <ChannelTabs channelId={channel.id} active="chat" />

      {isDm && dmPartnerReady === false && (
        <div className="border-b border-[var(--color-border)] bg-[var(--color-panel)]/60 px-4 py-1.5 text-center text-xs text-[var(--color-text-dim)]">
          Messages here aren't end-to-end encrypted yet — {channel.dm_user?.display_name ?? 'this person'} hasn't signed in since encryption shipped.
        </div>
      )}

      {!isDm ? <ActivePollBanner channel={channel} /> : null}

      {showSettings && (
        <ChannelSettingsModal channelId={channel.id} onClose={() => setShowSettings(false)} />
      )}

      {showSchedule && (
        <ScheduleMeetingModal channelId={channel.id} onClose={() => setShowSchedule(false)} />
      )}

      {/* messages */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden">
          {cm?.loading && messages.length === 0 ? (
            <LoadingSkeleton />
          ) : messages.length === 0 && cm?.loaded ? (
            <EmptyChannel name={channelLabel(channel, nicknames)} isDm={isDm} />
          ) : (
            <div className="pb-2 pt-3">
              {cm?.hasMore && (
                <div className="py-2 text-center text-xs text-[var(--color-text-faint)]">
                  {cm.loading ? 'Loading earlier messages…' : 'Scroll up for more'}
                </div>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1]
                const newDay = !prev || !sameDay(prev.created_at, m.created_at)
                const grouped =
                  !newDay &&
                  !!prev &&
                  prev.user.id === m.user.id &&
                  withinMinutes(prev.created_at, m.created_at, 5) &&
                  !prev.deleted_at
                return (
                  <div key={m.id}>
                    {newDay && <DayDivider iso={m.created_at} />}
                    <MessageItem
                      message={m}
                      grouped={grouped}
                      dm={bubbles}
                      showThread={!bubbles}
                      online={isDm ? undefined : online.has(m.user.id) || undefined}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <JumpToMessages
          count={pendingJump?.count ?? 0}
          atBottom={atBottom}
          disabled={messages.length === 0}
          onClick={jumpToMessages}
        />
      </div>

      <TypingRow channelId={channelId} />
      <div className="pointer-events-none relative z-30 h-0">
        <DuckSuggest channelId={channelId} />
      </div>
      <Composer
        key={channel.id}
        channel={channel}
        placeholder={`Message ${isDm ? channelLabel(channel, nicknames) : '#' + channel.name}`}
      />

      {needsLayoutChoice && <ChatLayoutChooser />}
    </div>
  )

  // Private conversations never reach a shared screen unshielded.
  if (isDm || channel.kind === 'private') {
    return (
      <StreamShield
        label={isDm ? 'Direct message hidden' : 'Private channel hidden'}
        channelId={channel.id}
        channelName={isDm ? channelLabel(channel, nicknames) : `#${channel.name}`}
      >
        {pane}
      </StreamShield>
    )
  }
  return pane
}

function JumpToMessages({
  count,
  atBottom,
  disabled,
  onClick,
}: {
  count: number
  atBottom: boolean
  disabled: boolean
  onClick: () => void
}) {
  const hasUnread = count > 0
  const hiddenAtBottom = atBottom && !hasUnread
  const label = hasUnread
    ? `Jump to ${count} new ${count === 1 ? 'message' : 'messages'}`
    : disabled
      ? 'No messages yet'
      : 'Jump to latest message'

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || hiddenAtBottom}
      aria-hidden={hiddenAtBottom || undefined}
      tabIndex={hiddenAtBottom ? -1 : 0}
      aria-label={label}
      title={label}
      className={`jump-messages-cta ${hasUnread ? 'jump-messages-cta--unread' : 'jump-messages-cta--latest'}`}
      data-at-bottom={hiddenAtBottom ? 'true' : undefined}
    >
      <svg
        className="jump-messages-cta__icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
      {hasUnread && (
        <span>
          {count} new {count === 1 ? 'message' : 'messages'}
        </span>
      )}
    </button>
  )
}

function VoiceIcon({ connecting }: { connecting: boolean }) {
  return (
    <span className="relative flex">
      <svg className="voice-waveform" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path className="voice-wave-bar" d="M3 10v4" />
        <path className="voice-wave-bar" d="M7 7v10" />
        <path className="voice-wave-bar" d="M11 4v16" />
        <path className="voice-wave-bar" d="M15 8v8" />
        <path className="voice-wave-bar" d="M19 10v4" />
      </svg>
      {connecting && (
        <span className="voice-connecting-dot absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full bg-[var(--color-accent-hover)]" />
      )}
    </span>
  )
}

function ScheduleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="17" rx="2" />
      <path d="M3 9h18M8 2v4M16 2v4M12 13v4M10 15h4" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m15 18-6-6 6-6" />
    </svg>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 px-4 pt-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex gap-3">
          <div className="skeleton h-9 w-9 rounded-md" />
          <div className="flex-1 space-y-2">
            <div className="skeleton h-3 w-32" />
            <div className="skeleton h-3" style={{ width: `${60 + ((i * 13) % 30)}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function EmptyChannel({ name, isDm }: { name: string; isDm: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-panel)] text-2xl text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
        {isDm ? '💬' : '#'}
      </div>
      <h2 className="text-lg font-semibold">
        {isDm ? name : `Welcome to #${name}`}
      </h2>
      <p className="max-w-sm text-sm text-[var(--color-text-dim)]">
        {isDm
          ? `This is the start of your conversation with ${name}.`
          : 'This is the very beginning of the channel. Say hello!'}
      </p>
    </div>
  )
}
