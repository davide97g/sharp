import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { fmtDayDivider } from '../../lib/util'
import type { DocKind, DocSearchResult, RecentDoc } from '../../lib/types'
import { useStore } from '../../store'
import { HubCard } from './HubCard'
import { HubFilters } from './HubFilters'
import { HubGrid } from './HubGrid'
import { HubPage } from './HubPage'
import { Button, EmptyState, SectionLabel } from '../../ui'

const paths: Record<DocKind, string> = { doc: '/d', canvas: '/x', board: '/b' }
const names: Record<DocKind, string> = { doc: 'Docs', canvas: 'Canvas', board: 'Boards' }

export function DocKindHub({ kind }: { kind: DocKind }) {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const channels = useStore((s) => s.channels)
  const docsByChannel = useStore((s) => s.docsByChannel)
  const docsLoaded = useStore((s) => s.docsLoaded)
  const loadChannelDocs = useStore((s) => s.loadChannelDocs)
  const createDoc = useStore((s) => s.createDoc)
  const users = useStore((s) => s.users)
  const [recent, setRecent] = useState<RecentDoc[]>([])
  const [searched, setSearched] = useState<DocSearchResult[] | null>(null)

  const query = params.get('q') ?? ''
  const selected = params.getAll('channel')
  const sort = params.get('sort') ?? 'updated'

  const memberChannels = useMemo(
    () => channels.filter((channel) => channel.is_member && channel.kind !== 'dm'),
    [channels],
  )

  const change = (key: string, value?: string, multi = false) => {
    const next = new URLSearchParams(params)
    if (multi && value) {
      const all = next.getAll(key)
      next.delete(key)
      const toggled = all.includes(value)
        ? all.filter((item) => item !== value)
        : [...all, value]
      toggled.forEach((item) => next.append(key, item))
    } else if (value) {
      next.set(key, value)
    } else {
      next.delete(key)
    }
    setParams(next, { replace: true })
  }

  // Default view is the workspace-wide recent feed; a channel filter switches
  // to per-channel loads so cached store data (and WS patches) apply.
  useEffect(() => {
    if (selected.length) {
      selected.forEach((id) => {
        if (!docsLoaded.has(id)) void loadChannelDocs(id)
      })
      return
    }
    void api
      .recentDocs(kind)
      .then((result) => setRecent(result.docs))
      .catch(() => setRecent([]))
  }, [kind, selected.join(','), docsLoaded, loadChannelDocs])

  useEffect(() => {
    const value = query.trim()
    if (!value) {
      setSearched(null)
      return
    }
    const timer = window.setTimeout(() => {
      void api
        .docSearch(value, 50)
        .then((result) => setSearched(result.results.filter((doc) => doc.kind === kind)))
        .catch(() => setSearched([]))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, kind])

  const rows = useMemo(() => {
    let list: RecentDoc[]
    if (searched) {
      list = searched.map((doc) => ({
        doc,
        channel_name: channels.find((channel) => channel.id === doc.channel_id)?.name ?? '',
      }))
    } else if (selected.length) {
      list = selected.flatMap((id) =>
        (docsByChannel[id] ?? [])
          .filter((doc) => doc.kind === kind && !doc.deleted_at)
          .map((doc) => ({
            doc,
            channel_name: channels.find((channel) => channel.id === id)?.name ?? '',
          })),
      )
    } else {
      list = recent
    }
    if (sort === 'title') list = [...list].sort((a, b) => a.doc.title.localeCompare(b.doc.title))
    if (sort === 'newest')
      list = [...list].sort((a, b) => (a.doc.created_at < b.doc.created_at ? 1 : -1))
    return list
  }, [searched, selected.join(','), docsByChannel, kind, recent, channels, sort])

  const newItem = async () => {
    const channel = memberChannels[0]
    if (!channel) return
    const doc = await createDoc(channel.id, { kind })
    navigate(`${paths[kind]}/${doc.id}`)
  }

  const icon = <KindIcon kind={kind} />

  return (
    <HubPage
      title={names[kind]}
      count={rows.length}
      primaryLabel={`New ${kind === 'doc' ? 'doc' : kind}`}
      onPrimary={() => void newItem()}
      query={query}
      onQueryChange={(value) => change('q', value || undefined)}
      sort={sort}
      onSortChange={(value) => change('sort', value === 'updated' ? undefined : value)}
      filters={
        <HubFilters
          channels={memberChannels}
          selected={selected}
          onToggle={(id) => change('channel', id, true)}
          onClear={() => change('channel', undefined)}
        />
      }
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section>
          {rows.length === 0 ? (
            <EmptyState
              variant="dashed"
              title={`No ${names[kind].toLowerCase()} here yet.`}
              action={
                <Button onClick={() => void newItem()}>
                  Create {kind === 'doc' ? 'first doc' : kind}
                </Button>
              }
            />
          ) : (
            <HubGrid>
              {rows.map(({ doc, channel_name }) => (
                <HubCard
                  key={doc.id}
                  icon={icon}
                  title={doc.title}
                  preview={searched?.find((result) => result.id === doc.id)?.snippet || doc.preview}
                  channel={channel_name}
                  updatedAt={fmtDayDivider(doc.updated_at)}
                  creatorId={doc.created_by}
                  creatorName={doc.created_by ? users[doc.created_by]?.display_name : undefined}
                  onOpen={() => navigate(`${paths[kind]}/${doc.id}`)}
                  onChannel={() => change('channel', doc.channel_id, true)}
                />
              ))}
            </HubGrid>
          )}
        </section>
        <Mentions kind={kind} />
      </div>
    </HubPage>
  )
}

function KindIcon({ kind }: { kind: DocKind }) {
  if (kind === 'doc')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </svg>
    )
  if (kind === 'canvas')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <rect x="4" y="4" width="7" height="7" rx="1" />
        <circle cx="16.5" cy="7.5" r="3.5" />
        <path d="M7.5 21 3 14h9z" />
      </svg>
    )
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="4" y="4" width="4" height="16" rx="1" />
      <rect x="10" y="4" width="4" height="11" rx="1" />
      <rect x="16" y="4" width="4" height="7" rx="1" />
    </svg>
  )
}

function Mentions({ kind }: { kind: DocKind }) {
  const mentions = useStore((s) => s.mentions).filter((mention) => mention.doc.kind === kind)
  const load = useStore((s) => s.loadMentions)
  const mark = useStore((s) => s.markMentionsRead)
  const navigate = useNavigate()

  useEffect(() => {
    void load()
  }, [load])

  return (
    <aside className="max-lg:order-first">
      <SectionLabel as="h2" size="xs" className="mb-3">
        Mentions
      </SectionLabel>
      {mentions.length ? (
        <div className="space-y-2">
          {mentions.map((mention) => (
            <button
              key={mention.id}
              onClick={() => {
                if (!mention.read_at) void mark([mention.id])
                navigate(`${paths[kind]}/${mention.doc.id}`)
              }}
              className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-3 text-left text-sm transition hover:bg-[var(--color-panel-2)]"
            >
              <span className="font-medium">{mention.from_user.display_name}</span>
              <span className="text-[var(--color-text-dim)]"> mentioned you in </span>
              <span className="font-medium">{mention.doc.title || 'Untitled'}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-faint)]">
          No mentions.
        </div>
      )}
    </aside>
  )
}
