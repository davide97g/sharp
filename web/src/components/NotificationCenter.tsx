import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { fmtRelative } from '../lib/util'
import { isTauri } from '../lib/notify'
import type { Notification } from '../lib/types'

const KIND_LABEL: Record<Notification['kind'], string> = {
  mention: 'mentioned you',
  dm: 'messaged you',
  reply: 'replied to your thread',
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const notifications = useStore((s) => s.notifications)
  const unread = useStore((s) => s.notifUnread)
  const dnd = useStore((s) => s.dnd)
  const notifyEnabled = useStore((s) => s.notifyEnabled)
  const notifHasMore = useStore((s) => s.notifHasMore)
  const markNotifRead = useStore((s) => s.markNotifRead)
  const markAllNotifRead = useStore((s) => s.markAllNotifRead)
  const setDnd = useStore((s) => s.setDnd)
  const loadMore = useStore((s) => s.loadMoreNotifications)
  const enableDesktop = useStore((s) => s.enableDesktopNotifications)
  const navigate = useNavigate()
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function openNotification(n: Notification) {
    markNotifRead(n.id)
    setOpen(false)
    navigate(`/c/${n.channel_id}`)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Notifications"
        className="relative flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
      >
        <span className="text-base leading-none">{dnd ? '🔕' : '🔔'}</span>
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <button
              onClick={markAllNotifRead}
              disabled={unread === 0}
              className="rounded px-1.5 py-0.5 text-[11px] text-[var(--color-accent-hover)] hover:bg-[var(--color-accent-soft)] disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>

          {/* controls */}
          <div className="flex flex-col gap-1.5 border-b border-[var(--color-border)] px-3 py-2">
            <label className="flex cursor-pointer items-center justify-between text-xs text-[var(--color-text-dim)]">
              <span>Do Not Disturb</span>
              <input
                type="checkbox"
                checked={dnd}
                onChange={(e) => setDnd(e.target.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
            </label>
            {!notifyEnabled && !isTauri && (
              <button
                onClick={enableDesktop}
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
              >
                Enable desktop notifications
              </button>
            )}
          </div>

          {/* list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-[var(--color-text-faint)]">
                You're all caught up.
              </div>
            ) : (
              <>
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => openNotification(n)}
                    className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--color-panel)] ${
                      n.read_at ? '' : 'bg-[var(--color-accent-soft)]/30'
                    }`}
                  >
                    <Avatar id={n.actor.id} name={n.actor.display_name} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm">
                          <span className="font-semibold text-[var(--color-text)]">
                            {n.actor.display_name}
                          </span>{' '}
                          <span className="text-[var(--color-text-faint)]">
                            {KIND_LABEL[n.kind]}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-faint)]">
                          {fmtRelative(n.created_at)}
                        </span>
                      </div>
                      {n.preview && (
                        <div className="truncate text-xs text-[var(--color-text-dim)]">
                          {n.preview}
                        </div>
                      )}
                      {n.channel_kind !== 'dm' && (
                        <div className="truncate text-[10px] text-[var(--color-text-faint)]">
                          #{n.channel_name}
                        </div>
                      )}
                    </div>
                    {!n.read_at && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />
                    )}
                  </button>
                ))}
                {notifHasMore && (
                  <button
                    onClick={loadMore}
                    className="w-full py-2 text-center text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel)]"
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
