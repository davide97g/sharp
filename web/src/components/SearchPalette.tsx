import { effectiveNicknames } from '../lib/displayName'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore, streamShieldOn } from '../store'
import { api } from '../lib/api'
import { channelLabel, fmtTime, fmtDayDivider } from '../lib/util'
import { toastError } from '../lib/toast'
import { gifPreviewText } from '../lib/gif'
import { localSearchResult, searchLocal } from '../lib/e2ee/search'
import { Avatar } from './Avatar'
import type { DocSearchResult, SearchResult } from '../lib/types'

type Scope =
  | { type: 'channel'; id: string; label: string; isDm: boolean }
  | { type: 'doc'; id: string; label: string; canvas: boolean }
  | null

type Group = 'scoped' | 'global'
type Row =
  | { kind: 'message'; group: Group; key: string; data: SearchResult }
  | { kind: 'doc'; group: Group; key: string; data: DocSearchResult }

const DEBOUNCE_MS = 200

/** Split ts_headline output (or a client snippet) on `<<`/`>>` markers into highlighted nodes. */
function Highlight({ text }: { text: string }) {
  const parts = text.split(/(<<.*?>>)/g).filter(Boolean)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('<<') && p.endsWith('>>') ? (
          <mark
            key={i}
            className="rounded bg-[var(--color-accent-soft)] px-0.5 text-[var(--color-text)]"
          >
            {p.slice(2, -2)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

/** Fallback snippet built client-side (used when the server returns no headline). */
function clientSnippet(text: string, query: string): string {
  const term = query.trim().split(/\s+/)[0] ?? ''
  if (!term) return text.slice(0, 120)
  const idx = text.toLowerCase().indexOf(term.toLowerCase())
  if (idx < 0) return text.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + term.length + 60)
  const pre = start > 0 ? '…' : ''
  const post = end < text.length ? '…' : ''
  return `${pre}${text.slice(start, idx)}<<${text.slice(idx, idx + term.length)}>>${text.slice(idx + term.length, end)}${post}`
}

function messageSnippet(result: SearchResult, query: string): string {
  const content = gifPreviewText(result.content)
  return content !== result.content
    ? clientSnippet(content, query)
    : gifPreviewText(result.snippet || clientSnippet(result.content, query))
}

export function SearchPalette() {
  const open = useStore((s) => s.searchOpen)
  const nicknames = useStore(effectiveNicknames)
  const setOpen = useStore((s) => s.setSearchOpen)
  const setFocus = useStore((s) => s.setFocus)
  const channels = useStore((s) => s.channels)
  const docMeta = useStore((s) => s.docMeta)
  const docsByChannel = useStore((s) => s.docsByChannel)
  const location = useLocation()
  const navigate = useNavigate()

  const [q, setQ] = useState('')
  const [scopedMsgs, setScopedMsgs] = useState<SearchResult[]>([])
  const [scopedDocs, setScopedDocs] = useState<DocSearchResult[]>([])
  const [globalMsgs, setGlobalMsgs] = useState<SearchResult[]>([])
  const [localMsgs, setLocalMsgs] = useState<SearchResult[]>([])
  const [globalDocs, setGlobalDocs] = useState<DocSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Current context, derived from the URL (authoritative for docs/canvas).
  const scope = useMemo<Scope>(() => {
    const p = location.pathname
    const chan = p.match(/^\/c\/([^/]+)/)
    if (chan) {
      const c = channels.find((c) => c.id === chan[1])
      if (c)
        return {
          type: 'channel',
          id: c.id,
          label: c.kind === 'dm' ? channelLabel(c, nicknames) : `#${c.name}`,
          isDm: c.kind === 'dm',
        }
      return { type: 'channel', id: chan[1], label: 'this chat', isDm: false }
    }
    const docm = p.match(/^\/([dx])\/([^/]+)/)
    if (docm) {
      const id = docm[2]
      const canvas = docm[1] === 'x'
      const meta =
        docMeta[id] ?? Object.values(docsByChannel).flat().find((d) => d.id === id)
      return {
        type: 'doc',
        id,
        label: meta?.title || (canvas ? 'this canvas' : 'this doc'),
        canvas,
      }
    }
    return null
  }, [location.pathname, channels, docMeta, docsByChannel])

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      setScopedMsgs([])
      setScopedDocs([])
      setGlobalMsgs([])
      setLocalMsgs([])
      setGlobalDocs([])
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Debounced fetch: scoped (current context) + global, in parallel.
  useEffect(() => {
    const query = q.trim()
    if (!query) {
      setScopedMsgs([])
      setScopedDocs([])
      setGlobalMsgs([])
      setLocalMsgs([])
      setGlobalDocs([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      const scopedReq: Promise<void> =
        scope?.type === 'channel'
          ? api.search(query, 15, scope.id).then((r) => {
              if (!cancelled) setScopedMsgs(r.results)
            })
          : scope?.type === 'doc'
            ? api.docSearch(query, 15, scope.id).then((r) => {
                if (!cancelled) setScopedDocs(r.results)
              })
            : Promise.resolve()

      Promise.all([
        scopedReq,
        api.search(query, 20).then((r) => {
          if (!cancelled) setGlobalMsgs(r.results)
        }),
        searchLocal(query, 20).then((rows) => {
          if (cancelled) return
          setLocalMsgs(
            rows.map((row) => {
              const channel = channels.find((item) => item.id === row.channelId)
              return localSearchResult(row, channel ? channelLabel(channel, nicknames) : 'Direct message')
            }),
          )
        }),
        api.docSearch(query, 20).then((r) => {
          if (!cancelled) setGlobalDocs(r.results)
        }),
      ])
        .catch((e) => {
          if (!cancelled && e instanceof Error) toastError(e.message)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q, scope, channels])

  // Build a single flat, keyboard-navigable list: scoped group first, then the rest.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    const seenMsg = new Set<string>()
    const seenDoc = new Set<string>()
    if (scope?.type === 'channel') {
      for (const m of scopedMsgs) {
        seenMsg.add(m.id)
        out.push({ kind: 'message', group: 'scoped', key: `m-${m.id}`, data: m })
      }
    } else if (scope?.type === 'doc') {
      for (const d of scopedDocs) {
        seenDoc.add(d.id)
        out.push({ kind: 'doc', group: 'scoped', key: `d-${d.id}`, data: d })
      }
    }
    for (const m of globalMsgs) {
      if (seenMsg.has(m.id)) continue
      seenMsg.add(m.id)
      out.push({ kind: 'message', group: 'global', key: `m-${m.id}`, data: m })
    }
    for (const m of localMsgs) {
      if (seenMsg.has(m.id)) continue
      seenMsg.add(m.id)
      out.push({ kind: 'message', group: 'global', key: `m-${m.id}`, data: m })
    }
    for (const d of globalDocs) {
      if (seenDoc.has(d.id)) continue
      out.push({ kind: 'doc', group: 'global', key: `d-${d.id}`, data: d })
    }
    return out
  }, [scope, scopedMsgs, scopedDocs, globalMsgs, globalDocs, localMsgs])

  useEffect(() => {
    setSel(0)
  }, [rows.length])

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`) as
      | HTMLElement
      | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  function choose(row: Row) {
    setOpen(false)
    if (row.kind === 'message') {
      // Land on the channel, then scroll to + highlight this message.
      setFocus({
        channelId: row.data.channel_id,
        messageId: row.data.id,
        query: q.trim(),
      })
      navigate(`/c/${row.data.channel_id}`)
    } else {
      navigate(`${row.data.kind === 'canvas' ? '/x' : row.data.kind === 'board' ? '/b' : '/d'}/${row.data.id}`)
    }
  }

  const shielded = useStore(streamShieldOn)
  const revealChannels = useStore((s) => s.streamRevealChannels)

  // Hits from private channels/DMs blur while streaming; unknown channels
  // (e.g. local encrypted-DM results) count as private. A live per-channel
  // reveal window unblurs that conversation's hits.
  function rowShielded(row: Row): boolean {
    if (!shielded) return false
    const kind = channels.find((c) => c.id === row.data.channel_id)?.kind
    if (kind === 'public') return false
    const until = revealChannels[row.data.channel_id]
    return !(until && Date.now() < until)
  }

  function locationLabel(row: Row): string {
    if (row.kind === 'message') {
      const ch = channels.find((c) => c.id === row.data.channel_id)
      if (ch?.kind === 'dm') return `DM · ${channelLabel(ch, nicknames)}`
      return `#${row.data.channel_name}`
    }
    const tag =
      row.data.kind === 'canvas' ? '🎨 Canvas' : row.data.kind === 'board' ? '🗂️ Board' : '📄 Doc'
    return `${tag} · #${row.data.channel_name}`
  }

  if (!open) return null

  const scopedCount = rows.filter((r) => r.group === 'scoped').length
  const hasScoped = scope !== null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[max(14vh,calc(var(--safe-top)+1.5rem))] pb-[max(1rem,var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] pr-[max(1rem,var(--safe-right))] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="flex w-full max-w-xl animate-in flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {hasScoped && (
          <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 pt-3 text-[11px] text-[var(--color-text-faint)]">
            <span>Searching in</span>
            <span className="rounded bg-[var(--color-accent-soft)] px-1.5 py-0.5 font-medium text-[var(--color-text)]">
              {scope!.type === 'channel' ? 'chat' : scope!.canvas ? 'canvas' : 'doc'}:{' '}
              {scope!.label}
            </span>
          </div>
        )}
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, rows.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (rows[sel]) choose(rows[sel])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Search messages and docs…"
          className="w-full border-b border-[var(--color-border)] bg-transparent px-4 py-3.5 text-sm focus:outline-none"
        />
        <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {loading && rows.length === 0 && (
            <div className="space-y-2 p-1.5">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="skeleton h-14 rounded-lg" />
              ))}
            </div>
          )}
          {!loading && q.trim() && rows.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-[var(--color-text-faint)]">
              No matches for “{q.trim()}”.
            </div>
          )}
          {!q.trim() && (
            <div className="px-3 py-8 text-center text-sm text-[var(--color-text-faint)]">
              Search across your channels, DMs and docs.
            </div>
          )}
          {rows.map((row, i) => {
            const prev = rows[i - 1]
            const showScopedHeader = row.group === 'scoped' && i === 0
            const showGlobalHeader =
              row.group === 'global' && (!prev || prev.group === 'scoped')
            return (
              <div key={row.key}>
                {showScopedHeader && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                    In this {scope!.type === 'channel' ? 'chat' : 'doc'} · {scopedCount}
                  </div>
                )}
                {showGlobalHeader && (
                  <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-faint)]">
                    {hasScoped ? 'Elsewhere' : 'All results'}
                  </div>
                )}
                <button
                  data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(row)}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left ${
                    i === sel
                      ? 'bg-[var(--color-accent-soft)]'
                      : 'hover:bg-[var(--color-panel-2)]'
                  }`}
                >
                  {row.kind === 'message' ? (
                    <span className={rowShielded(row) ? 'stream-blur' : undefined}>
                      <Avatar
                        id={row.data.user.id}
                        name={row.data.user.display_name}
                        size={28}
                      />
                    </span>
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center text-lg">
                      {row.data.icon || (row.data.kind === 'canvas' ? '🎨' : row.data.kind === 'board' ? '🗂️' : '📄')}
                    </span>
                  )}
                  <div className={`min-w-0 flex-1 ${rowShielded(row) ? 'stream-blur' : ''}`}>
                    <div className="mb-0.5 flex items-center gap-2 text-[11px]">
                      <span className="truncate font-medium text-[var(--color-accent-hover)]">
                        {locationLabel(row)}
                      </span>
                      {row.kind === 'message' && row.data.local ? (
                        <span title="Local encrypted DM result">🔒</span>
                      ) : null}
                      {row.kind === 'message' && (
                        <span className="shrink-0 text-[var(--color-text-faint)]">
                          {row.data.user.display_name} ·{' '}
                          {fmtDayDivider(row.data.created_at)} {fmtTime(row.data.created_at)}
                        </span>
                      )}
                      {row.kind === 'doc' && (
                        <span className="shrink-0 truncate font-medium text-[var(--color-text)]">
                          {row.data.title || 'Untitled'}
                        </span>
                      )}
                    </div>
                    <p className="line-clamp-2 text-xs text-[var(--color-text-dim)]">
                      <Highlight
                        text={
                          row.kind === 'message'
                            ? messageSnippet(row.data, q)
                            : row.data.snippet || row.data.preview || ''
                        }
                      />
                    </p>
                  </div>
                </button>
              </div>
            )
          })}
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-faint)]">
          ↑↓ to navigate · ↵ to open · esc to close
        </div>
      </div>
    </div>
  )
}
