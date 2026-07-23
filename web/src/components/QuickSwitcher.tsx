import { effectiveNicknames } from '../lib/displayName'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, streamShieldOn } from '../store'
import { channelLabel, fuzzyScore } from '../lib/util'
import { toastError } from '../lib/toast'
import { sound } from '../lib/sound'
import type { DocKind } from '../lib/types'

// `priv` marks entries whose label must blur while the Privacy Shield is on;
// `chanId` lets a per-conversation reveal window unblur them.
type Item =
  | { kind: 'channel'; id: string; label: string; sub: string; icon: string; priv?: boolean; chanId?: string }
  | { kind: 'user'; id: string; label: string; sub: string; icon: string; priv?: boolean; chanId?: string }
  | { kind: 'doc'; id: string; label: string; sub: string; icon: string; docKind: DocKind; priv?: boolean; chanId?: string }
  | { kind: 'task'; id: string; label: string; sub: string; icon: string; path: string; priv?: boolean; chanId?: string }

export function QuickSwitcher() {
  const open = useStore((s) => s.quickSwitcherOpen)
  const nicknames = useStore(effectiveNicknames)
  const setOpen = useStore((s) => s.setQuickSwitcher)
  const channels = useStore((s) => s.channels)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const online = useStore((s) => s.online)
  const openDm = useStore((s) => s.openDm)
  const docsByChannel = useStore((s) => s.docsByChannel)
  const navigate = useNavigate()

  const shielded = useStore(streamShieldOn)
  const revealChannels = useStore((s) => s.streamRevealChannels)
  const itemShielded = (it: Item) => {
    if (!shielded || !it.priv) return false
    const until = it.chanId ? revealChannels[it.chanId] : undefined
    return !(until && Date.now() < until)
  }
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      sound.switcherOpen()
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const chanItems: Item[] = channels.map((c) =>
      c.kind === 'dm'
        ? {
            kind: 'channel',
            id: c.id,
            label: channelLabel(c, nicknames),
            sub: 'Direct message',
            icon: online.has(c.dm_user?.id ?? '') ? '🟢' : '💬',
            priv: true,
            chanId: c.id,
          }
        : {
            kind: 'channel',
            id: c.id,
            label: c.name,
            sub: c.is_member ? 'Channel' : 'Public channel',
            icon: '#',
            priv: c.kind === 'private',
            chanId: c.id,
          },
    )
    const dmUserIds = new Set(
      channels.filter((c) => c.kind === 'dm').map((c) => c.dm_user?.id),
    )
    const userItems: Item[] = Object.values(users)
      .filter((u) => u.id !== me?.id && !dmUserIds.has(u.id))
      .map((u) => ({
        kind: 'user',
        id: u.id,
        label: nicknames[u.id]?.trim() || u.display_name,
        sub: 'Open direct message',
        icon: online.has(u.id) ? '🟢' : '👤',
      }))
    const chanName: Record<string, string> = {}
    const chanPriv: Record<string, boolean> = {}
    for (const c of channels) {
      chanName[c.id] = c.kind === 'dm' ? channelLabel(c, nicknames) : c.name
      chanPriv[c.id] = c.kind !== 'public'
    }
    const docItems: Item[] = Object.values(docsByChannel)
      .flat()
      .filter((d) => !d.deleted_at)
      .map((d) => ({
        kind: 'doc',
        id: d.id,
        label: d.title || 'Untitled',
        sub: `${d.kind === 'canvas' ? 'Canvas' : 'Doc'} · #${chanName[d.channel_id] ?? ''}`,
        icon: d.icon || (d.kind === 'canvas' ? '🎨' : '📄'),
        docKind: d.kind,
        priv: chanPriv[d.channel_id] ?? false,
        chanId: d.channel_id,
      }))
    return [...chanItems, ...userItems, ...docItems]
  }, [channels, users, me, online, docsByChannel, nicknames])

  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const myTasks = useStore((s) => s.myTasks)

  // Loaded tasks are matchable by identifier or title ("SHARP-12", "login flake").
  const taskItems = useMemo<Item[]>(() => {
    const seen = new Set<string>()
    const out: Item[] = []
    for (const t of [...myTasks, ...Object.values(tasksByProject).flat()]) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      const at = t.identifier.lastIndexOf('-')
      out.push({
        kind: 'task',
        id: t.id,
        label: `${t.identifier} ${t.title}`,
        sub: 'Task',
        icon: '🎯',
        path: `/t/${t.identifier.slice(0, at).toLowerCase()}/${t.number}`,
      })
    }
    return out
  }, [myTasks, tasksByProject])

  const filtered = useMemo(() => {
    const query = q.trim()
    const all = [...items, ...taskItems]
    if (!query) return items.slice(0, 20)
    // Exact identifier prefix (e.g. "SHARP-12") jumps straight to tasks even if
    // that task list isn't loaded yet: synthesize a jump item from the keys.
    const identifierMatch = /^([A-Za-z][A-Za-z0-9]{1,5})-(\d+)$/.exec(query)
    const synthesized: Item[] = []
    if (identifierMatch) {
      const key = identifierMatch[1].toUpperCase()
      if (projects.some((p) => p.key === key)) {
        const identifier = `${key}-${identifierMatch[2]}`
        if (!taskItems.some((t) => t.label.startsWith(`${identifier} `))) {
          synthesized.push({
            kind: 'task',
            id: identifier,
            label: identifier,
            sub: 'Open task',
            icon: '🎯',
            path: `/t/${key.toLowerCase()}/${identifierMatch[2]}`,
          })
        }
      }
    }
    return [
      ...synthesized,
      ...all
        .map((it) => ({ it, score: fuzzyScore(query, it.label) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20 - synthesized.length)
        .map((x) => x.it),
    ]
  }, [items, taskItems, projects, q])

  useEffect(() => {
    setSel(0)
  }, [q])

  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  async function choose(it: Item) {
    setOpen(false)
    if (it.kind === 'channel') {
      navigate(`/c/${it.id}`)
    } else if (it.kind === 'task') {
      navigate(it.path)
    } else if (it.kind === 'doc') {
      navigate(`${it.docKind === 'canvas' ? '/x' : '/d'}/${it.id}`)
    } else {
      try {
        const ch = await openDm(it.id)
        navigate(`/c/${ch.id}`)
      } catch (e) {
        if (e instanceof Error) toastError(e.message)
      }
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[max(14vh,calc(var(--safe-top)+1.5rem))] pb-[max(1rem,var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] pr-[max(1rem,var(--safe-right))] backdrop-blur-sm"
      onMouseDown={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg animate-in overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSel((s) => Math.min(s + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSel((s) => Math.max(s - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (filtered[sel]) choose(filtered[sel])
            } else if (e.key === 'Escape') {
              setOpen(false)
            }
          }}
          placeholder="Jump to a channel or person…"
          className="w-full border-b border-[var(--color-border)] bg-transparent px-4 py-3.5 text-sm focus:outline-none"
        />
        <div ref={listRef} className="max-h-[45vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-[var(--color-text-faint)]">
              No matches.
            </div>
          )}
          {filtered.map((it, i) => (
            <button
              key={`${it.kind}-${it.id}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(it)}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${
                i === sel ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-panel-2)]'
              }`}
            >
              <span className="flex h-6 w-6 items-center justify-center text-sm text-[var(--color-text-faint)]">
                {it.icon}
              </span>
              <span className={`min-w-0 flex-1 ${itemShielded(it) ? 'stream-blur' : ''}`}>
                <span className="block truncate text-sm font-medium">{it.label}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-faint)]">
                  {it.sub}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-faint)]">
          ↑↓ to navigate · ↵ to select · esc to close
        </div>
      </div>
    </div>
  )
}
