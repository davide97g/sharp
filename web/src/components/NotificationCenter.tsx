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
        aria-label="Notifications"
        className={`relative flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
          open
            ? 'bg-[var(--color-panel-2)] text-[var(--color-text)]'
            : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
        }`}
      >
        <span className="text-base leading-none">{dnd ? '🔕' : '🔔'}</span>
        {unread > 0 && !dnd && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold leading-none text-white ring-2 ring-[var(--color-ink)]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-2 flex max-h-[75vh] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel-2)] shadow-2xl">
          {/* header */}
          <div className="flex items-center justify-between gap-2 px-4 pb-2.5 pt-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Notifications</h2>
              {unread > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-bold leading-none text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
            <button
              onClick={markAllNotifRead}
              disabled={unread === 0}
              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-accent-hover)] transition-colors hover:bg-[var(--color-accent-soft)] disabled:pointer-events-none disabled:opacity-40"
            >
              Mark all read
            </button>
          </div>

          {/* controls */}
          <div className="flex flex-col gap-2 border-y border-[var(--color-border)] bg-[var(--color-ink)]/40 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="text-base leading-none">{dnd ? '🌙' : '🔔'}</span>
                <div className="min-w-0">
                  <div className="text-xs font-medium text-[var(--color-text)]">Do Not Disturb</div>
                  <div className="truncate text-[10px] text-[var(--color-text-faint)]">
                    Mutes toasts, popups &amp; push
                  </div>
                </div>
              </div>
              <Toggle checked={dnd} onChange={setDnd} label="Do Not Disturb" />
            </div>
            {!notifyEnabled && !isTauri && (
              <button
                onClick={enableDesktop}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--color-border)] px-2 py-1.5 text-[11px] font-medium text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
              >
                <span aria-hidden>🖥️</span> Enable desktop notifications
              </button>
            )}
          </div>

          {/* list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
                <span className="text-3xl opacity-50" aria-hidden>
                  🔔
                </span>
                <span className="text-sm font-medium text-[var(--color-text-dim)]">
                  You're all caught up
                </span>
                <span className="text-xs text-[var(--color-text-faint)]">
                  New mentions and messages show up here.
                </span>
              </div>
            ) : (
              <>
                {notifications.map((n) => {
                  const unreadItem = !n.read_at
                  return (
                    <button
                      key={n.id}
                      onClick={() => openNotification(n)}
                      className={`flex w-full items-start gap-3 border-l-2 px-4 py-3 text-left transition-colors ${
                        unreadItem
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]/25 hover:bg-[var(--color-accent-soft)]/40'
                          : 'border-transparent hover:bg-[var(--color-panel)]'
                      }`}
                    >
                      <Avatar id={n.actor.id} name={n.actor.display_name} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-sm">
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
                          <div className="mt-0.5 line-clamp-2 text-xs text-[var(--color-text-dim)]">
                            {n.preview}
                          </div>
                        )}
                        {n.channel_kind !== 'dm' && (
                          <div className="mt-1 inline-flex max-w-full items-center gap-0.5 truncate rounded bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-faint)]">
                            #{n.channel_name}
                          </div>
                        )}
                      </div>
                      {unreadItem && (
                        <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]" />
                      )}
                    </button>
                  )
                })}
                {notifHasMore && (
                  <button
                    onClick={loadMore}
                    className="w-full py-2.5 text-center text-xs font-medium text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    Load older
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

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}
