import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useStore } from '../store'
import { MessageItem } from './MessageItem'
import { DayDivider } from './DayDivider'
import { Composer } from './Composer'
import { TypingRow } from './TypingRow'
import { ChannelSettingsModal } from './ChannelSettingsModal'
import { ChatLayoutChooser } from './ChatLayoutChooser'
import { Avatar } from './Avatar'
import { channelLabel, sameDay, withinMinutes } from '../lib/util'

export function MessagePane() {
  const { channelId } = useParams<{ channelId: string }>()
  const channels = useStore((s) => s.channels)
  const channel = channels.find((c) => c.id === channelId)
  const cm = useStore((s) => (channelId ? s.byChannel[channelId] : undefined))
  const online = useStore((s) => s.online)
  const setCurrentChannel = useStore((s) => s.setCurrentChannel)
  const loadMessages = useStore((s) => s.loadMessages)
  const loadOlder = useStore((s) => s.loadOlder)
  const markRead = useStore((s) => s.markRead)
  const mutedChannels = useStore((s) => s.mutedChannels)
  const toggleMute = useStore((s) => s.toggleMute)
  const chatLayout = useStore((s) => s.chatLayout)
  const [showSettings, setShowSettings] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const pendingRestoreRef = useRef<number | null>(null)
  const prevLenRef = useRef(0)
  const prevChannelRef = useRef<string | undefined>(undefined)
  const readTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // set current channel + load
  useEffect(() => {
    if (!channelId) return
    setCurrentChannel(channelId)
    const st = useStore.getState().byChannel[channelId]
    if (!st?.loaded && !st?.loading) loadMessages(channelId)
    return () => setCurrentChannel(null)
  }, [channelId, setCurrentChannel, loadMessages])

  const messages = cm?.list ?? []
  const lastId = messages.length ? messages[messages.length - 1].id : null

  // scroll management
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const channelChanged = prevChannelRef.current !== channelId
    prevChannelRef.current = channelId

    if (pendingRestoreRef.current !== null) {
      // restore after prepending older messages
      el.scrollTop = el.scrollHeight - pendingRestoreRef.current
      pendingRestoreRef.current = null
    } else if (channelChanged || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
    prevLenRef.current = messages.length
  }, [messages.length, channelId])

  // mark read when at bottom & new content
  useEffect(() => {
    if (!channelId || !lastId) return
    if (!atBottomRef.current) return
    if (readTimerRef.current) clearTimeout(readTimerRef.current)
    readTimerRef.current = setTimeout(() => {
      markRead(channelId, lastId)
    }, 400)
    return () => {
      if (readTimerRef.current) clearTimeout(readTimerRef.current)
    }
  }, [channelId, lastId, markRead])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottomRef.current = distanceFromBottom < 80

    if (el.scrollTop < 140 && cm?.hasMore && !cm.loading && channelId) {
      pendingRestoreRef.current = el.scrollHeight - el.scrollTop
      loadOlder(channelId)
    }
    // mark read once user reaches bottom
    if (atBottomRef.current && channelId && lastId) {
      markRead(channelId, lastId)
    }
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

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      {/* header */}
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <div className="flex min-w-0 items-center gap-2">
          {isDm ? (
            <span className="flex items-center gap-2 font-semibold">
              {channel.dm_user && (
                <Avatar
                  id={channel.dm_user.id}
                  name={channel.dm_user.display_name}
                  size={26}
                  online={dmOnline}
                />
              )}
              {channelLabel(channel)}
            </span>
          ) : (
            <button
              onClick={() => setShowSettings(true)}
              title="Channel settings"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 font-semibold hover:bg-[var(--color-panel)]"
            >
              <span className="text-[var(--color-text-faint)]">#</span>
              {channel.name}
              {channel.kind === 'private' && (
                <span className="text-[var(--color-text-faint)]" title="Private">
                  🔒
                </span>
              )}
            </button>
          )}
        </div>
        {channel.topic && (
          <>
            <span className="text-[var(--color-border)]">|</span>
            <span className="truncate text-sm text-[var(--color-text-dim)]">
              {channel.topic}
            </span>
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!isDm && (
            <button
              onClick={() => setShowSettings(true)}
              title="Channel settings"
              className="rounded-md px-2 py-1 text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
            >
              ⚙
            </button>
          )}
          <button
            onClick={() => toggleMute(channel.id)}
            title={mutedChannels.has(channel.id) ? 'Unmute this channel' : 'Mute this channel'}
            className="rounded-md px-2 py-1 text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
          >
            {mutedChannels.has(channel.id) ? '🔕' : '🔔'}
          </button>
        </div>
      </header>

      {showSettings && !isDm && (
        <ChannelSettingsModal channelId={channel.id} onClose={() => setShowSettings(false)} />
      )}

      {/* messages */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto">
        {cm?.loading && messages.length === 0 ? (
          <LoadingSkeleton />
        ) : messages.length === 0 && cm?.loaded ? (
          <EmptyChannel name={channelLabel(channel)} isDm={isDm} />
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

      <TypingRow channelId={channelId} />
      <Composer channel={channel} placeholder={`Message ${isDm ? channelLabel(channel) : '#' + channel.name}`} />

      {needsLayoutChoice && <ChatLayoutChooser />}
    </div>
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
