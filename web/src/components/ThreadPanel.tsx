import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useIsMobile } from '../lib/useMediaQuery'
import { MessageItem } from './MessageItem'
import { Composer } from './Composer'

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
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          {isMobile && (
            <button
              type="button"
              onClick={closeThread}
              aria-label="Back to channel"
              className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-xl text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          )}
          <div className="flex min-w-0 flex-col">
            <span className="text-sm font-semibold">Thread</span>
            {channel && (
              <span className="truncate text-xs text-[var(--color-text-faint)]">
                {channel.kind === 'dm' ? channel.dm_user?.display_name : `#${channel.name}`}
              </span>
            )}
          </div>
        </div>
        {!isMobile && (
          <button
            onClick={closeThread}
            title="Close (Esc)"
            className="rounded-md px-2 py-1 text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        )}
      </header>

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
    </aside>
  )
}
