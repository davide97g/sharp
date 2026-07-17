import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { fmtDayDivider, fmtRelative, sameDay } from '../lib/util'
import { isTauri } from '../lib/notify'
import { gifPreviewText } from '../lib/gif'
import type { Notification, NotificationKind } from '../lib/types'

type Filter = 'all' | NotificationKind

const KIND_META: Record<
  NotificationKind,
  { label: string; verb: string; accent: string }
> = {
  mention: {
    label: 'Mentions',
    verb: 'mentioned you',
    accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]',
  },
  dm: {
    label: 'DMs',
    verb: 'sent a message',
    accent: 'bg-emerald-500/15 text-emerald-300',
  },
  reply: {
    label: 'Replies',
    verb: 'replied to your thread',
    accent: 'bg-amber-500/15 text-amber-300',
  },
}

export function InboxTrigger({ variant }: { variant: 'row' | 'icon' | 'header' }) {
  const open = useStore((s) => s.inboxOpen)
  const setInboxOpen = useStore((s) => s.setInboxOpen)
  const unread = useStore((s) => s.notifUnread)
  const dnd = useStore((s) => s.dnd)

  if (variant === 'header') {
    return (
      <button
        type="button"
        onClick={() => setInboxOpen(!open)}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
        aria-expanded={open}
        title="Inbox"
        className={`relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          open
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-inset ring-[var(--color-accent)]'
            : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
        }`}
      >
        <BellIcon dnd={dnd} />
        {unread > 0 && !dnd && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-bold leading-none text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    )
  }

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={() => setInboxOpen(!open)}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
        aria-expanded={open}
        title="Inbox"
        className={`relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
          open
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]'
            : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
        }`}
      >
        <BellIcon dnd={dnd} />
        {unread > 0 && !dnd && <CountBadge count={unread} ring="ring-[var(--color-panel)]" />}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setInboxOpen(!open)}
      aria-expanded={open}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
        open
          ? 'bg-[var(--color-accent-soft)] text-white'
          : 'text-[var(--color-text)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
          open
            ? 'bg-[var(--color-accent)]/30 text-[var(--color-accent-hover)]'
            : 'bg-[var(--color-panel-2)] text-[var(--color-text-dim)]'
        }`}
      >
        <BellIcon dnd={dnd} />
      </span>
      <span className="min-w-0 flex-1 font-medium">Inbox</span>
      {dnd && (
        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
          Quiet
        </span>
      )}
      {unread > 0 && !dnd && (
        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-bold leading-none text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

export function InboxPanel() {
  const open = useStore((s) => s.inboxOpen)
  const setInboxOpen = useStore((s) => s.setInboxOpen)
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
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setInboxOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setInboxOpen])

  useEffect(() => {
    if (!open) setFilter('all')
  }, [open])

  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => n.kind === filter)),
    [notifications, filter],
  )

  const groups = useMemo(() => groupByDay(filtered), [filtered])

  const counts = useMemo(() => {
    const c = { mention: 0, dm: 0, reply: 0, unread: 0 }
    for (const n of notifications) {
      if (!n.read_at) {
        c.unread++
        c[n.kind]++
      }
    }
    return c
  }, [notifications])

  function openNotification(n: Notification) {
    markNotifRead(n.id)
    setInboxOpen(false)
    navigate(`/c/${n.channel_id}`)
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Inbox">
      <button
        type="button"
        aria-label="Close inbox"
        className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-[2px]"
        onClick={() => setInboxOpen(false)}
      />
      <aside
        className="inbox-panel relative flex h-full w-full max-w-[26rem] flex-col border-l border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl max-md:max-w-none"
        style={{
          paddingTop: 'var(--safe-top)',
          paddingBottom: 'var(--safe-bottom)',
          paddingRight: 'var(--safe-right)',
        }}
      >
        {/* header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 pb-3 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-[var(--color-text)]">
                Inbox
              </h2>
              {unread > 0 && (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-bold leading-none text-white">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
              Mentions, DMs, and thread replies
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={markAllNotifRead}
              disabled={unread === 0}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-accent-hover)] transition-colors hover:bg-[var(--color-accent-soft)] disabled:pointer-events-none disabled:opacity-35"
            >
              Mark all read
            </button>
            <button
              type="button"
              onClick={() => setInboxOpen(false)}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* quiet mode */}
        <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-ink)]/50 px-5 py-2.5">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--color-text)]">Do not disturb</div>
            <div className="truncate text-[10px] text-[var(--color-text-faint)]">
              Keep the inbox, silence toasts &amp; push
            </div>
          </div>
          <Toggle checked={dnd} onChange={setDnd} label="Do not disturb" />
        </div>

        {!notifyEnabled && !isTauri && (
          <button
            type="button"
            onClick={enableDesktop}
            className="mx-4 mt-3 flex items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] px-3 py-2 text-[11px] font-medium text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            Enable desktop notifications
          </button>
        )}

        {/* filters */}
        <div className="flex gap-1 overflow-x-auto px-4 py-3">
          <FilterChip
            active={filter === 'all'}
            onClick={() => setFilter('all')}
            label="All"
            count={counts.unread}
          />
          {(['mention', 'dm', 'reply'] as const).map((kind) => (
            <FilterChip
              key={kind}
              active={filter === kind}
              onClick={() => setFilter(kind)}
              label={KIND_META[kind].label}
              count={counts[kind]}
            />
          ))}
        </div>

        {/* list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {filtered.length === 0 ? (
            <EmptyState filter={filter} />
          ) : (
            <>
              {groups.map((group) => (
                <section key={group.label} className="mb-3">
                  <h3 className="sticky top-0 z-10 bg-[var(--color-panel)]/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)] backdrop-blur-sm">
                    {group.label}
                  </h3>
                  <div className="space-y-0.5">
                    {group.items.map((n) => (
                      <InboxRow key={n.id} n={n} onOpen={() => openNotification(n)} />
                    ))}
                  </div>
                </section>
              ))}
              {notifHasMore && filter === 'all' && (
                <button
                  type="button"
                  onClick={loadMore}
                  className="mx-2 mt-1 w-[calc(100%-1rem)] rounded-lg py-2.5 text-center text-xs font-medium text-[var(--color-text-dim)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                >
                  Load older
                </button>
              )}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}

function InboxRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const unread = !n.read_at
  const meta = KIND_META[n.kind]
  const preview = gifPreviewText(n.preview)
  const where =
    n.channel_kind === 'dm' ? 'Direct message' : `#${n.channel_name}`

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
        unread
          ? 'bg-[var(--color-accent-soft)]/40 hover:bg-[var(--color-accent-soft)]/65'
          : 'hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <div className="relative shrink-0">
        <Avatar id={n.actor.id} name={n.actor.display_name} size={36} />
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-[var(--color-panel)] ${meta.accent}`}
          aria-hidden
        >
          <KindGlyph kind={n.kind} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm text-[var(--color-text)]">
            <span className="font-semibold">{n.actor.display_name}</span>{' '}
            <span className="font-normal text-[var(--color-text-faint)]">{meta.verb}</span>
          </p>
          <time className="shrink-0 text-[10px] tabular-nums text-[var(--color-text-faint)]">
            {fmtRelative(n.created_at)}
          </time>
        </div>
        {preview && (
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[var(--color-text-dim)]">
            {preview}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="truncate rounded-md bg-[var(--color-ink)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-faint)]">
            {where}
          </span>
          {unread && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
          )}
        </div>
      </div>
    </button>
  )
}

function EmptyState({ filter }: { filter: Filter }) {
  const copy =
    filter === 'all'
      ? { title: "You're all caught up", sub: 'Mentions, DMs, and replies land here.' }
      : filter === 'mention'
        ? { title: 'No mentions', sub: 'When someone @you, it shows up here.' }
        : filter === 'dm'
          ? { title: 'No direct messages', sub: 'New DMs will appear in this filter.' }
          : { title: 'No thread replies', sub: 'Replies to your threads show up here.' }

  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-panel-2)] text-[var(--color-text-faint)] ring-1 ring-[var(--color-border)]">
        <BellIcon dnd={false} size={22} />
      </div>
      <p className="text-sm font-medium text-[var(--color-text-dim)]">{copy.title}</p>
      <p className="mt-1 text-xs text-[var(--color-text-faint)]">{copy.sub}</p>
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active
          ? 'bg-[var(--color-accent)] text-white'
          : 'bg-[var(--color-panel-2)] text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`tabular-nums ${active ? 'text-white/80' : 'text-[var(--color-text-faint)]'}`}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}

function groupByDay(items: Notification[]): { label: string; items: Notification[] }[] {
  const groups: { label: string; items: Notification[] }[] = []
  for (const n of items) {
    const last = groups[groups.length - 1]
    if (last && sameDay(last.items[0].created_at, n.created_at)) {
      last.items.push(n)
    } else {
      groups.push({ label: fmtDayDivider(n.created_at), items: [n] })
    }
  }
  return groups
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

function CountBadge({ count, ring }: { count: number; ring: string }) {
  return (
    <span
      className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-bold leading-none text-white ${ring} ring-2`}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

function BellIcon({ dnd, size = 16 }: { dnd: boolean; size?: number }) {
  if (dnd) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M18.4 18.4A7.5 7.5 0 0 1 5.5 16V11c0-.3 0-.6.05-.9" />
        <path d="M8.5 5.1A6.5 6.5 0 0 1 18.5 11v1.5" />
        <path d="M10 20a2 2 0 0 0 4 0" />
        <path d="m3 3 18 18" />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

function KindGlyph({ kind }: { kind: NotificationKind }) {
  switch (kind) {
    case 'mention':
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9" />
        </svg>
      )
    case 'dm':
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      )
    case 'reply':
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="9 17 4 12 9 7" />
          <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
        </svg>
      )
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  )
}
