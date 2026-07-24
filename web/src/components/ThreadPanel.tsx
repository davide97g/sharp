import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useIsMobile } from '../lib/useMediaQuery'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'
import { StreamShield } from './stream/StreamShield'
import { PanelHeader, IconButton, ChevronLeftIcon } from '../ui'
import type { Channel } from '../lib/types'

export function ThreadPanel() {
  const thread = useStore((s) => s.thread)
  const channels = useStore((s) => s.channels)
  const online = useStore((s) => s.online)
  const closeThread = useStore((s) => s.closeThread)
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)

  const channel = thread.parent
    ? channels.find((c) => c.id === thread.parent!.channel_id)
    : undefined

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread.replies.length])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeThread()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeThread])

  if (!thread.open) return null

  return (
    <aside
      className={
        isMobile
          ? 'mobile-sheet'
          : 'flex w-[400px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)]'
      }
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile ? true : undefined}
      aria-label="Thread"
    >
      <ThreadShield channel={channel ?? null}>
      <PanelHeader
        title="Thread"
        subtitle={
          channel
            ? channel.kind === 'dm'
              ? channel.dm_user?.display_name
              : `#${channel.name}`
            : undefined
        }
        icon={
          isMobile ? (
            <IconButton label="Back to channel" size="lg" onClick={closeThread}>
              <ChevronLeftIcon size={20} />
            </IconButton>
          ) : undefined
        }
        onClose={isMobile ? undefined : closeThread}
      />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3">
        {thread.loading && !thread.parent ? (
          <div className="space-y-3 px-4">
            <div className="skeleton h-12" />
            <div className="skeleton h-10" />
          </div>
        ) : (
          <>
            {thread.parent && (
              <MessageItem
                message={thread.parent}
                grouped={false}
                showThread={false}
                online={online.has(thread.parent.user.id) || undefined}
              />
            )}
            <div className="my-2 flex items-center gap-3 px-4">
              <div className="h-px flex-1 bg-[var(--color-border)]" />
              <span className="text-xs text-[var(--color-text-faint)]">
                {thread.replies.length}{' '}
                {thread.replies.length === 1 ? 'reply' : 'replies'}
              </span>
              <div className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            {thread.replies.map((r, i) => {
              const prev = thread.replies[i - 1]
              const grouped =
                !!prev &&
                prev.user.id === r.user.id &&
                Math.abs(
                  new Date(r.created_at).getTime() - new Date(prev.created_at).getTime(),
                ) <=
                  5 * 60000
              return (
                <MessageItem
                  key={r.id}
                  message={r}
                  grouped={grouped}
                  showThread={false}
                  online={online.has(r.user.id) || undefined}
                />
              )
            })}
          </>
        )}
      </div>

      {channel && thread.parent && (
        <Composer channel={channel} parentId={thread.parent.id} placeholder="Reply…" />
      )}
      </ThreadShield>
    </aside>
  )
}

/** Threads from private channels/DMs shield like their parent pane. */
function ThreadShield({
  channel,
  children,
}: {
  channel: Channel | null
  children: React.ReactNode
}) {
  if (!channel || channel.kind === 'public') return <>{children}</>
  return (
    <StreamShield
      label="Private thread hidden"
      channelId={channel.id}
      channelName={channel.kind === 'dm' ? channel.dm_user?.display_name : `#${channel.name}`}
    >
      {children}
    </StreamShield>
  )
}
