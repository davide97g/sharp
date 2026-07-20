import { memo, useCallback } from 'react'
import type { BoardCardData, BoardProperty } from '../../lib/boardDoc'
import { colorOf } from '../../lib/boardColors'
import type { ChannelMember } from '../../lib/types'
import { initials, userColor } from '../../lib/util'

// Parse a stored 'YYYY-MM-DD' as a *local* date (never let the browser read it
// as UTC midnight and shift the day).
function parseDate(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function shortDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function isOverdue(d: Date): boolean {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return d.getTime() < today
}

export type BoardCardProps = {
  card: BoardCardData
  properties: BoardProperty[]
  members: ChannelMember[] | undefined
  canEdit: boolean
  dragging: boolean
  onOpen: (cardId: string) => void
  onPointerDown: (e: React.PointerEvent, cardId: string) => void
  consumeSuppressClick: () => boolean
  registerCard: (id: string, el: HTMLElement | null) => void
}

function BoardCardImpl({
  card,
  properties,
  members,
  canEdit,
  dragging,
  onOpen,
  onPointerDown,
  consumeSuppressClick,
  registerCard,
}: BoardCardProps) {
  const ref = useCallback(
    (el: HTMLElement | null) => registerCard(card.id, el),
    [registerCard, card.id],
  )

  // Chips: multi-select tags, then due-date chips (skip the status select — it
  // is expressed by the column).
  const tags: { key: string; label: string; color: string }[] = []
  const dates: { key: string; label: string; overdue: boolean }[] = []
  let assigneeId: string | null = null
  for (const p of properties) {
    const v = card.values[p.id]
    if (p.type === 'multiSelect' && Array.isArray(v)) {
      for (const optId of v) {
        const opt = p.options?.find((o) => o.id === optId)
        if (opt) tags.push({ key: `${p.id}:${optId}`, label: opt.label, color: opt.color })
      }
    } else if (p.type === 'date' && typeof v === 'string' && v) {
      const d = parseDate(v)
      if (d) dates.push({ key: p.id, label: shortDate(d), overdue: isOverdue(d) })
    } else if (p.type === 'assignee' && typeof v === 'string' && v) {
      assigneeId = v
    }
  }

  const assignee = assigneeId ? members?.find((m) => m.id === assigneeId) : undefined
  const hasMeta = tags.length > 0 || dates.length > 0 || !!assigneeId

  return (
    <div
      ref={ref}
      onPointerDown={(e) => onPointerDown(e, card.id)}
      onClick={() => {
        if (consumeSuppressClick()) return
        onOpen(card.id)
      }}
      className={`group select-none rounded-lg border bg-[var(--color-panel-2)] px-3 py-2.5 text-sm transition-colors ${
        dragging
          ? 'border-dashed border-[var(--color-border)] opacity-40'
          : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
      } ${canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      <div className="line-clamp-2 leading-snug text-[var(--color-text)]">
        {card.title || <span className="text-[var(--color-text-faint)]">Untitled</span>}
      </div>

      {hasMeta && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {tags.map((t) => {
            const c = colorOf(t.color)
            return (
              <span
                key={t.key}
                className="max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: c.bg, color: c.fg }}
              >
                {t.label}
              </span>
            )
          })}
          {dates.map((d) => (
            <span
              key={d.key}
              className="rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                backgroundColor: 'var(--color-panel)',
                color: d.overdue ? 'var(--board-red-fg)' : 'var(--color-text-dim)',
              }}
            >
              {d.label}
            </span>
          ))}
          {assigneeId && (
            <span
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
              title={assignee?.display_name ?? 'Unknown'}
              style={{ backgroundColor: assignee ? userColor(assignee.id) : '#4b4b56' }}
            >
              {assignee ? initials(assignee.display_name) : '?'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

export const BoardCard = memo(BoardCardImpl)
