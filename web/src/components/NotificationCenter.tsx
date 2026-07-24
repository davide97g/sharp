import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, streamChannelShielded } from '../store'
import { Avatar } from './Avatar'
import { fmtDayDivider, fmtRelative, sameDay } from '../lib/util'
import { isTauri } from '../lib/notify'
import { gifPreviewText } from '../lib/gif'
import { notificationPath } from '../lib/types'
import type { Notification, NotificationKind } from '../lib/types'
import { NotificationSetup } from './NotificationSetup'
import { Toggle } from './Toggle'
import { Button, CountBadge, EmptyState, SlideOver } from '../ui'

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
    accent: 'bg-success-soft text-success-fg',
  },
  reply: {
    label: 'Replies',
    verb: 'replied to your thread',
    accent: 'bg-warning-soft text-warning-fg',
  },
  // TODO(ds): no violet/sky tone tokens exist for these decorative kind accents.
  poll_ended: {
    label: 'Polls',
    verb: 'closed a poll',
    accent: 'bg-violet-500/15 text-violet-300',
  },
  task_assigned: {
    label: 'Tasks',
    verb: 'assigned you a task',
    accent: 'bg-sky-500/15 text-sky-300',
  },
  task_comment: {
    label: 'Task comments',
    verb: 'commented on your task',
    accent: 'bg-sky-500/15 text-sky-300',
  },
}

// Shared navigation for a notification: mark it read, focus its message (if any),
// then route to its target. Used by both the inbox panel and the rail bell preview.
function useOpenNotification() {
  const markNotifRead = useStore((s) => s.markNotifRead)
  const setFocus = useStore((s) => s.setFocus)
  const navigate = useNavigate()
  return useCallback(
    (n: Notification) => {
      markNotifRead(n.id)
      if (n.message_id && n.channel_id) {
        setFocus({ channelId: n.channel_id, messageId: n.message_id, query: '' })
      }
      navigate(notificationPath(n))
    },
    [markNotifRead, setFocus, navigate],
  )
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
        className={`relative flex h-10 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] sm:h-8 ${
          open
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-inset ring-[var(--color-accent)]'
            : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
        }`}
      >
        <BellIcon dnd={dnd} />
        {unread > 0 && !dnd && <CountBadge count={unread} />}
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
        {/* TODO(ds): ui CountBadge lacks absolute-positioned ring; keep local RingCountBadge. */}
        {unread > 0 && !dnd && <RingCountBadge count={unread} ring="ring-[var(--color-panel)]" />}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setInboxOpen(!open)}
      aria-expanded={open}
      className={`flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
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
        <span className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
          Quiet
        </span>
      )}
      {unread > 0 && !dnd && <CountBadge count={unread} className="h-5 min-w-5 px-1.5" />}
    </button>
  )
}

export function InboxPanel() {
  const open = useStore((s) => s.inboxOpen)
  const setInboxOpen = useStore((s) => s.setInboxOpen)
  const notifications = useStore((s) => s.notifications)
  const unread = useStore((s) => s.notifUnread)
  const dnd = useStore((s) => s.dnd)
  const notifHasMore = useStore((s) => s.notifHasMore)
  const markAllNotifRead = useStore((s) => s.markAllNotifRead)
  const setDnd = useStore((s) => s.setDnd)
  const loadMore = useStore((s) => s.loadMoreNotifications)
  const goToNotification = useOpenNotification()
  const [filter, setFilter] = useState<Filter>('all')

  // Escape close is handled by SlideOver.

  useEffect(() => {
    if (!open) setFilter('all')
  }, [open])

  const filtered = useMemo(
    () => (filter === 'all' ? notifications : notifications.filter((n) => n.kind === filter)),
    [notifications, filter],
  )

  const groups = useMemo(() => groupByDay(filtered), [filtered])

  const counts = useMemo(() => {
    const c: Record<NotificationKind | 'unread', number> = {
      mention: 0,
      dm: 0,
      reply: 0,
      poll_ended: 0,
      task_assigned: 0,
      task_comment: 0,
      unread: 0,
    }
    for (const n of notifications) {
      if (!n.read_at) {
        c.unread++
        c[n.kind]++
      }
    }
    return c
  }, [notifications])

  function openNotification(n: Notification) {
    setInboxOpen(false)
    goToNotification(n)
  }

  if (!open) return null

  return (
    <SlideOver
      onClose={() => setInboxOpen(false)}
      title={
        <span className="flex items-center gap-2">
          Inbox
          {unread > 0 && <CountBadge count={unread} className="h-5 min-w-5 px-1.5" />}
        </span>
      }
      subtitle="Mentions, DMs, replies, and poll results"
      headerActions={
        // TODO(ds): no accent-text button variant; keep native accent link-button.
        <button
          type="button"
          onClick={markAllNotifRead}
          disabled={unread === 0}
          className="min-h-11 rounded-md px-2 text-2xs font-medium text-[var(--color-accent-hover)] transition-colors hover:bg-[var(--color-accent-soft)] disabled:pointer-events-none disabled:opacity-35"
        >
          Mark all read
        </button>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* quiet mode */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-ink)]/50 px-5 py-2.5">
          <div className="min-w-0">
            <div className="text-xs font-medium text-[var(--color-text)]">Do not disturb</div>
            <div className="truncate text-3xs text-[var(--color-text-faint)]">
              Keep the inbox, silence toasts &amp; push
            </div>
          </div>
          <Toggle checked={dnd} onChange={setDnd} label="Do not disturb" />
        </div>

        {!isTauri && (
          <div className="mx-4 mt-3 shrink-0">
            <NotificationSetup compact />
          </div>
        )}

        {/* filters */}
        <div className="flex shrink-0 gap-1 overflow-x-auto px-4 py-3">
          <FilterChip
            active={filter === 'all'}
            onClick={() => setFilter('all')}
            label="All"
            count={counts.unread}
          />
          {(['mention', 'dm', 'reply', 'poll_ended', 'task_assigned', 'task_comment'] as const).map((kind) => (
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
            <InboxEmpty filter={filter} />
          ) : (
            <>
              {groups.map((group) => (
                <section key={group.label} className="mb-3">
                  <h3 className="sticky top-0 z-10 bg-[var(--color-panel)]/95 px-3 py-1.5 text-3xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)] backdrop-blur-sm">
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
                <Button
                  variant="ghost"
                  onClick={loadMore}
                  className="mx-2 mt-1 w-[calc(100%-1rem)] justify-center text-xs"
                >
                  Load older
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </SlideOver>
  )
}

// A jumping inbox bell for the workspace mode rail: bounces macOS-dock-style when
// a notification lands, opens the inbox on click, and reveals a 3-item preview on
// hover where each row navigates directly to its target (no slide-over).
export function RailInboxBell({
  orientation,
  edge = 'bottom',
  tip,
}: {
  orientation: 'vertical' | 'horizontal'
  edge?: 'bottom' | 'top'
  tip?: 'above' | 'below'
}) {
  const setInboxOpen = useStore((s) => s.setInboxOpen)
  const inboxOpen = useStore((s) => s.inboxOpen)
  const unread = useStore((s) => s.notifUnread)
  const dnd = useStore((s) => s.dnd)
  const notifications = useStore((s) => s.notifications)
  const goToNotification = useOpenNotification()
  const [hover, setHover] = useState(false)
  const [bounceKey, setBounceKey] = useState(0)
  const prevUnread = useRef(unread)

  // Bounce whenever the unread count climbs (a new notification arrived). Skips
  // decrements (marking read) and stays quiet while DND is on.
  useEffect(() => {
    if (!dnd && unread > prevUnread.current) setBounceKey((k) => k + 1)
    prevUnread.current = unread
  }, [unread, dnd])

  const preview = notifications.slice(0, 3)
  const showPreview = hover && !inboxOpen && preview.length > 0

  // Reveal the preview on the free side of the rail.
  const placement =
    orientation === 'vertical'
      ? 'left-full top-0 ml-2'
      : edge === 'top'
        ? 'top-full right-0 mt-2'
        : 'bottom-full right-0 mb-2'

  return (
    <div
      className="relative"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={() => setInboxOpen(true)}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
        aria-expanded={inboxOpen}
        title={tip ? undefined : 'Inbox'}
        data-tooltip={tip ? 'Inbox' : undefined}
        data-tip={tip}
        className={`mode-rail-control micro-icon-button relative flex h-11 w-11 items-center justify-center rounded-xl transition ${
          inboxOpen
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]'
            : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
        }`}
      >
        <span
          key={bounceKey}
          className={`micro-icon-glyph flex items-center justify-center ${
            bounceKey > 0 ? 'animate-bell-bounce' : ''
          }`}
        >
          <BellIcon dnd={dnd} size={18} />
        </span>
        {unread > 0 && !dnd && <CountBadge count={unread} className="absolute -right-1 -top-1" />}
      </button>
      {showPreview && (
        <div
          className={`absolute ${placement} z-(--z-popover) w-80 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[0_18px_40px_rgba(0,0,0,0.45)]`}
          role="menu"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <span className="text-xs font-semibold text-[var(--color-text)]">Latest</span>
            <button
              type="button"
              onClick={() => {
                setHover(false)
                setInboxOpen(true)
              }}
              className="rounded px-1.5 py-0.5 text-2xs font-medium text-[var(--color-accent-hover)] transition-colors hover:bg-[var(--color-accent-soft)]"
            >
              Open inbox
            </button>
          </div>
          <div className="p-1">
            {preview.map((n) => (
              <NotifPreviewRow
                key={n.id}
                n={n}
                onOpen={() => {
                  setHover(false)
                  goToNotification(n)
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NotifPreviewRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const meta = KIND_META[n.kind]
  const preview = gifPreviewText(n.preview)
  const unread = !n.read_at
  const shielded =
    useStore((s) => streamChannelShielded(s, n.channel_id)) &&
    (n.kind === 'dm' || n.channel_kind === 'dm' || n.channel_kind === 'private')

  return (
    <button
      type="button"
      onClick={onOpen}
      role="menuitem"
      className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors ${
        unread
          ? 'bg-[var(--color-accent-soft)]/35 hover:bg-[var(--color-accent-soft)]/60'
          : 'hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <div className={shielded ? 'stream-blur' : ''}>
        <Avatar id={n.actor.id} name={n.actor.display_name} size={30} />
      </div>
      <div className={`min-w-0 flex-1 ${shielded ? 'stream-blur' : ''}`}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-xs text-[var(--color-text)]">
            <span className="font-semibold">{n.actor.display_name}</span>{' '}
            <span className="font-normal text-[var(--color-text-faint)]">{meta.verb}</span>
          </p>
          <time className="shrink-0 text-3xs tabular-nums text-[var(--color-text-faint)]">
            {fmtRelative(n.created_at)}
          </time>
        </div>
        {preview && (
          <p className="mt-0.5 line-clamp-1 text-2xs text-[var(--color-text-dim)]">{preview}</p>
        )}
      </div>
    </button>
  )
}

function InboxRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const unread = !n.read_at
  const meta = KIND_META[n.kind]
  const preview = gifPreviewText(n.preview)
  const shielded =
    useStore((s) => streamChannelShielded(s, n.channel_id)) &&
    (n.kind === 'dm' || n.channel_kind === 'dm' || n.channel_kind === 'private')
  const where = n.task_identifier
    ? n.task_identifier
    : n.channel_kind === 'dm'
      ? 'Direct message'
      : `#${n.channel_name}`

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
      <div className={`relative shrink-0 ${shielded ? 'stream-blur' : ''}`}>
        <Avatar id={n.actor.id} name={n.actor.display_name} size={36} />
        <span
          className={`absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-2 ring-[var(--color-panel)] ${meta.accent}`}
          aria-hidden
        >
          <KindGlyph kind={n.kind} />
        </span>
      </div>
      <div className={`min-w-0 flex-1 ${shielded ? 'stream-blur' : ''}`}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="min-w-0 truncate text-sm text-[var(--color-text)]">
            <span className="font-semibold">{n.actor.display_name}</span>{' '}
            <span className="font-normal text-[var(--color-text-faint)]">{meta.verb}</span>
          </p>
          <time className="shrink-0 text-3xs tabular-nums text-[var(--color-text-faint)]">
            {fmtRelative(n.created_at)}
          </time>
        </div>
        {preview && (
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[var(--color-text-dim)]">
            {preview}
          </p>
        )}
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="truncate rounded-md bg-[var(--color-ink)] px-1.5 py-0.5 text-3xs font-medium text-[var(--color-text-faint)]">
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

function InboxEmpty({ filter }: { filter: Filter }) {
  const copy =
    filter === 'all'
      ? { title: "You're all caught up", sub: 'Mentions, DMs, and replies land here.' }
      : filter === 'mention'
        ? { title: 'No mentions', sub: 'When someone @you, it shows up here.' }
        : filter === 'dm'
          ? { title: 'No direct messages', sub: 'New DMs will appear in this filter.' }
          : filter === 'reply'
            ? { title: 'No thread replies', sub: 'Replies to your threads show up here.' }
            : filter === 'task_assigned' || filter === 'task_comment'
              ? { title: 'No task activity', sub: 'Task assignments and comments show up here.' }
              : { title: 'No poll results', sub: 'Polls you created or voted in show up here.' }

  return <EmptyState icon={<BellIcon dnd={false} size={22} />} title={copy.title} description={copy.sub} />
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
      className={`flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-2xs font-medium transition-colors ${
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

function RingCountBadge({ count, ring }: { count: number; ring: string }) {
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
    case 'poll_ended':
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 20V10M12 20V4M19 20v-7" />
        </svg>
      )
    case 'task_assigned':
    case 'task_comment':
      return (
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 5-5.5" />
        </svg>
      )
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

