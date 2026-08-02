// The returning-user half of the home screen: your trail, then what moved.
//
// Layout logic lives here rather than in `Home.tsx` so the welcome hero stays a
// hero — see `homeData.ts` for where each list comes from. Every row is a real
// destination; nothing on this board is decorative.

import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Banner,
  BoardIcon,
  CanvasIcon,
  Card,
  CountBadge,
  DocIcon,
  ListRow,
  SectionLabel,
  Skeleton,
  Button,
  HashIcon,
  UserIcon,
} from '../../ui'
import { useStore, streamShieldOn } from '../../store'
import { channelLabel, fmtDurationMs, fmtRelative } from '../../lib/util'
import { effectiveNicknames } from '../../lib/displayName'
import { joinScheduledMeeting, shortTime } from '../../lib/calendar'
import { recordVisit } from '../../lib/frecency'
import type { RecentEntry, RecentKind } from '../../lib/recents'
import type { Channel, RecentDoc } from '../../lib/types'
import {
  useActiveConversations,
  useRecentDocs,
  useResume,
  useUpNext,
} from './homeData'

const KIND_GLYPH: Record<RecentKind, ReactNode> = {
  channel: <HashIcon size={15} />,
  dm: <UserIcon size={15} />,
  doc: <DocIcon size={15} />,
  canvas: <CanvasIcon size={15} />,
  board: <BoardIcon size={15} />,
}

// Opening something here should teach the command palette, so the key has to be
// the one the palette files it under: DMs count as channels, and every doc kind
// counts as a doc.
const FRECENCY_KIND: Partial<Record<RecentKind, string>> = {
  channel: 'channel',
  dm: 'channel',
  doc: 'doc',
  canvas: 'doc',
  board: 'doc',
}

/**
 * Privacy-shield test, matching the quick switcher: a private label stays
 * blurred unless this conversation is inside its reveal window.
 */
function useShieldTest() {
  const shielded = useStore(streamShieldOn)
  const reveal = useStore((s) => s.streamRevealChannels)
  return (priv?: boolean, chanId?: string) => {
    if (!shielded || !priv) return false
    const until = chanId ? reveal[chanId] : undefined
    return !(until && Date.now() < until)
  }
}

/**
 * The one thing on this screen with a deadline, so it sits above everything —
 * including the ask box. Renders nothing when the next 24 hours are clear.
 */
export function UpNextBanner() {
  const upNext = useUpNext()
  if (!upNext) return null

  return (
    <Banner
      tone="accent"
      className="mb-4 text-left"
      icon={<span className="home-pulse" aria-hidden="true" />}
      actions={
        upNext.joinable ? (
          <Button size="sm" onClick={() => joinScheduledMeeting(upNext.joinPath)}>
            Join
          </Button>
        ) : undefined
      }
    >
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <SectionLabel size="3xs" tone="accent" as="span">
          Up next
        </SectionLabel>
        <span className="truncate font-medium">{upNext.item.title || 'Untitled event'}</span>
        <span className="font-mono text-2xs tabular-nums text-text-dim">
          {shortTime(upNext.item.start_at)}
          {upNext.startsInMs > 0
            ? ` · in ${fmtDurationMs(upNext.startsInMs)}`
            : ' · started'}
        </span>
      </span>
    </Banner>
  )
}

export function HomeBoard() {
  const resume = useResume()
  // One thing, one place: whatever the rail is already offering back is dropped
  // from the lanes below, so the board never lists the same row twice.
  const onRail = new Set(resume.map((entry) => entry.id))

  return (
    <div className="home-board">
      {resume.length > 0 && <ResumeSection entries={resume} />}
      <UpdateLanes hide={onRail} />
    </div>
  )
}

function ResumeSection({ entries }: { entries: RecentEntry[] }) {
  const navigate = useNavigate()
  const shielded = useShieldTest()
  const channels = useStore((s) => s.channels)

  return (
    <section aria-labelledby="home-resume-title" className="mb-7">
      <SectionLabel as="h2" id="home-resume-title" className="mb-2.5 px-0.5">
        Pick up where you left off
      </SectionLabel>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {entries.map((entry) => (
          <Card
            key={`${entry.kind}:${entry.id}`}
            as="button"
            interactive
            padding="sm"
            onClick={() => {
              const kind = FRECENCY_KIND[entry.kind]
              if (kind) recordVisit(`${kind}:${entry.id}`)
              navigate(entry.path)
            }}
            className="flex items-start gap-2.5"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-sm text-accent-hover"
            >
              {entry.icon || KIND_GLYPH[entry.kind]}
            </span>
            <span className={`min-w-0 flex-1 ${shielded(entry.priv, entry.chanId) ? 'stream-blur' : ''}`}>
              <span className="block truncate text-sm font-medium">{entry.title}</span>
              <span className="block truncate text-2xs text-text-faint">{entry.sub}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {/* The unread count travels with the card, so pulling a channel
                  out of the lane below never loses its badge. */}
              <CountBadge
                count={channels.find((c) => c.id === entry.id)?.unread_count ?? 0}
              />
              <span className="font-mono text-2xs tabular-nums text-text-faint">
                {fmtRelative(new Date(entry.at).toISOString())}
              </span>
            </span>
          </Card>
        ))}
      </div>
    </section>
  )
}

/**
 * Only lanes with something in them render, and the section disappears when
 * none do. An empty card is a hole in the layout that says nothing — and after
 * the rail takes its share, empty lanes are common in a small workspace.
 */
function UpdateLanes({ hide }: { hide: Set<string> }) {
  const conversations = useActiveConversations().filter((channel) => !hide.has(channel.id))
  const { docs: allDocs, loading: docsLoading } = useRecentDocs()
  const docs = allDocs.filter((entry) => !hide.has(entry.doc.id))
  const lanes = [
    conversations.length > 0 && <ConversationsLane key="chat" channels={conversations} />,
    (docs.length > 0 || docsLoading) && (
      <DocsLane key="docs" docs={docs} loading={docsLoading} />
    ),
  ].filter(Boolean)

  if (lanes.length === 0) return null

  return (
    <section aria-labelledby="home-updates-title">
      <SectionLabel as="h2" id="home-updates-title" className="mb-2.5 px-0.5">
        What moved
      </SectionLabel>
      <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{lanes}</div>
    </section>
  )
}

function Lane({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card padding="none" className="flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
        <SectionLabel as="h3">{title}</SectionLabel>
        {count ? <CountBadge count={count} /> : null}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="flex-1 p-1.5">{children}</div>
    </Card>
  )
}

function LaneLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-1 text-2xs font-medium text-text-faint outline-none transition-colors hover:text-accent-hover focus-visible:ring-2 focus-visible:ring-accent"
    >
      {label}
    </button>
  )
}

function ConversationsLane({ channels }: { channels: Channel[] }) {
  const nicknames = useStore(effectiveNicknames)
  const navigate = useNavigate()
  const shielded = useShieldTest()
  const unread = channels.reduce((n, c) => n + (c.unread_count ? 1 : 0), 0)

  return (
    <Lane title="Conversations" count={unread}>
      {channels.map((channel) => {
          const dm = channel.kind === 'dm'
          const blur = shielded(dm || channel.kind === 'private', channel.id)
          return (
            <ListRow
              key={channel.id}
              size="sm"
              onClick={() => {
                recordVisit(`channel:${channel.id}`)
                navigate(`/c/${channel.id}`)
              }}
              leading={
                <span aria-hidden="true" className="shrink-0 text-text-faint">
                  {dm ? <UserIcon size={14} /> : <HashIcon size={14} />}
                </span>
              }
              trailing={
                <>
                  <CountBadge count={channel.unread_count} />
                  {channel.last_message_at && (
                    <span className="font-mono text-2xs tabular-nums text-text-faint">
                      {fmtRelative(channel.last_message_at)}
                    </span>
                  )}
                </>
              }
            >
              <span className={blur ? 'stream-blur' : ''}>
                {channelLabel(channel, nicknames)}
              </span>
            </ListRow>
        )
      })}
    </Lane>
  )
}

const DOC_ROUTE = { doc: '/d', canvas: '/x', board: '/b' } as const
const DOC_GLYPH = { doc: DocIcon, canvas: CanvasIcon, board: BoardIcon } as const

function DocsLane({ docs, loading }: { docs: RecentDoc[]; loading: boolean }) {
  const navigate = useNavigate()

  return (
    <Lane title="Docs & canvases" action={<LaneLink label="All docs" onClick={() => navigate('/docs')} />}>
      {loading && docs.length === 0 ? (
        <div className="space-y-2 p-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : (
        docs.map(({ doc, channel_name }) => {
          const Glyph = DOC_GLYPH[doc.kind]
          return (
            <ListRow
              key={doc.id}
              size="sm"
              onClick={() => {
                recordVisit(`doc:${doc.id}`)
                navigate(`${DOC_ROUTE[doc.kind]}/${doc.id}`)
              }}
              leading={
                <span aria-hidden="true" className="shrink-0 text-sm text-text-faint">
                  {doc.icon || <Glyph size={14} />}
                </span>
              }
              trailing={
                <span className="font-mono text-2xs tabular-nums text-text-faint">
                  {fmtRelative(doc.updated_at)}
                </span>
              }
            >
              {doc.title || 'Untitled'}
              {channel_name && <span className="text-text-faint"> · #{channel_name}</span>}
            </ListRow>
          )
        })
      )}
    </Lane>
  )
}
