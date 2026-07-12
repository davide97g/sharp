import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { channelLabel, fuzzyScore } from '../lib/util'
import { toastError } from '../lib/toast'

type Item =
  | { kind: 'channel'; id: string; label: string; sub: string; icon: string }
  | { kind: 'user'; id: string; label: string; sub: string; icon: string }
  | { kind: 'doc'; id: string; label: string; sub: string; icon: string }

export function QuickSwitcher() {
  const open = useStore((s) => s.quickSwitcherOpen)
  const setOpen = useStore((s) => s.setQuickSwitcher)
  const channels = useStore((s) => s.channels)
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const online = useStore((s) => s.online)
  const openDm = useStore((s) => s.openDm)
  const docsByChannel = useStore((s) => s.docsByChannel)
  const navigate = useNavigate()

  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const chanItems: Item[] = channels.map((c) =>
      c.kind === 'dm'
        ? {
            kind: 'channel',
            id: c.id,
            label: channelLabel(c),
            sub: 'Direct message',
            icon: online.has(c.dm_user?.id ?? '') ? '🟢' : '💬',
          }
        : {
            kind: 'channel',
            id: c.id,
            label: c.name,
            sub: c.is_member ? 'Channel' : 'Public channel',
            icon: '#',
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
        label: u.display_name,
        sub: 'Open direct message',
        icon: online.has(u.id) ? '🟢' : '👤',
      }))
    const chanName: Record<string, string> = {}
    for (const c of channels) chanName[c.id] = c.kind === 'dm' ? channelLabel(c) : c.name
    const docItems: Item[] = Object.values(docsByChannel)
      .flat()
      .filter((d) => !d.deleted_at)
      .map((d) => ({
        kind: 'doc',
        id: d.id,
        label: d.title || 'Untitled',
        sub: `Doc · #${chanName[d.channel_id] ?? ''}`,
        icon: d.icon || '📄',
      }))
    return [...chanItems, ...userItems, ...docItems]
  }, [channels, users, me, online, docsByChannel])

  const filtered = useMemo(() => {
    const query = q.trim()
    if (!query) return items.slice(0, 20)
    return items
      .map((it) => ({ it, score: fuzzyScore(query, it.label) }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((x) => x.it)
  }, [items, q])

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
    } else if (it.kind === 'doc') {
      navigate(`/d/${it.id}`)
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
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 p-4 pt-[14vh] backdrop-blur-sm"
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
              <span className="min-w-0 flex-1">
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
