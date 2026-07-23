import { effectiveNicknames } from '../../lib/displayName'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStore } from '../../store'
import { channelLabel, sameDay, withinMinutes } from '../../lib/util'
import { MessageItem } from '../MessageItem'
import { DayDivider } from '../DayDivider'
import { Composer } from '../Composer'
import { TypingRow } from '../TypingRow'

// Slack-huddle chat rail: the message thread of the SAME channel/DM the call is
// in, so people can chat while on the call. Reuses the regular chat building
// blocks (MessageItem/DayDivider/TypingRow/Composer) and loads the call
// channel's messages independently of whichever channel is open on the route.
export function CallChatRail({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels.find((c) => c.id === channelId))
  const nicknames = useStore(effectiveNicknames)
  const cm = useStore((s) => s.byChannel[channelId])
  const online = useStore((s) => s.online)
  const chatLayout = useStore((s) => s.chatLayout)
  const loadMessages = useStore((s) => s.loadMessages)
  const loadOlder = useStore((s) => s.loadOlder)
  const markRead = useStore((s) => s.markRead)

  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const pendingRestoreRef = useRef<number | null>(null)
  const prevChannelRef = useRef<string | null>(null)
  const prevTailRef = useRef<string | null>(null)

  // Load this channel's messages the same way the main view does (works even
  // when the call channel isn't the currently open channel).
  useEffect(() => {
    const st = useStore.getState().byChannel[channelId]
    if (!st?.loaded && !st?.loading) void loadMessages(channelId)
  }, [channelId, loadMessages])

  const messages = cm?.list ?? []
  const lastId = messages.length ? messages[messages.length - 1].id : null

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const channelChanged = prevChannelRef.current !== channelId
    const tailChanged = !channelChanged && prevTailRef.current !== lastId
    prevChannelRef.current = channelId
    prevTailRef.current = lastId
    if (channelChanged || tailChanged) {
      pendingRestoreRef.current = null
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    } else if (pendingRestoreRef.current !== null) {
      el.scrollTop = el.scrollHeight - pendingRestoreRef.current
      pendingRestoreRef.current = null
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
  }, [messages.length, lastId, channelId])

  // Mark read once new content lands while we're at the bottom.
  useEffect(() => {
    if (!lastId || !atBottomRef.current) return
    const timer = setTimeout(() => markRead(channelId, lastId), 400)
    return () => clearTimeout(timer)
  }, [channelId, lastId, markRead])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (el.scrollTop < 140 && cm?.hasMore && !cm.loading) {
      pendingRestoreRef.current = el.scrollHeight - el.scrollTop
      void loadOlder(channelId)
    }
    if (atBottomRef.current && lastId) markRead(channelId, lastId)
  }

  if (!channel) return null

  const isDm = channel.kind === 'dm'
  const bubbles = isDm && chatLayout === 'bubble'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--color-ink)]">
      <header className="flex h-11 shrink-0 items-center border-b border-[var(--color-border)] px-4">
        <span className="truncate text-sm font-semibold">Chat</span>
        <span className="ml-2 truncate text-xs text-[var(--color-text-faint)]">
          {isDm ? channelLabel(channel, nicknames) : `#${channel.name}`}
        </span>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto overflow-x-hidden">
        {cm?.loading && messages.length === 0 ? (
          <div className="p-4 text-sm text-[var(--color-text-faint)]">Loading messages…</div>
        ) : messages.length === 0 && cm?.loaded ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-[var(--color-text-dim)]">
            No messages yet. Say hello!
          </div>
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
      <Composer
        key={channel.id}
        channel={channel}
        placeholder={`Message ${isDm ? channelLabel(channel, nicknames) : '#' + channel.name}`}
      />
    </div>
  )
}
