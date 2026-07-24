import { memo, useCallback } from 'react'
import type { BoardCardData, BoardProperty } from '../../lib/boardDoc'
import type { ChannelMember } from '../../lib/types'
import { initials, userColor } from '../../lib/util'
import { Tag } from '../../ui'

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
  groupByPropertyId: string | null
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
  groupByPropertyId,
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

  // Chips shown on the card: single-select + multi-select tags, then due-date
  // chips, then the assignee avatar. A property is shown only when its
  // card-visibility toggle is on (undefined = on); the group-by select is never
  // shown as a chip because the column already expresses it.
  const chips: { key: string; label: string; color: string }[] = []
  const dates: { key: string; label: string; overdue: boolean }[] = []
  let assigneeId: string | null = null
  for (const p of properties) {
    if (p.showOnCard === false || p.id === groupByPropertyId) continue
    const v = card.values[p.id]
    if (p.type === 'select' && typeof v === 'string' && v) {
      const opt = p.options?.find((o) => o.id === v)
      if (opt) chips.push({ key: p.id, label: opt.label, color: opt.color })
    } else if (p.type === 'multiSelect' && Array.isArray(v)) {
      for (const optId of v) {
        const opt = p.options?.find((o) => o.id === optId)
        if (opt) chips.push({ key: `${p.id}:${optId}`, label: opt.label, color: opt.color })
      }
    } else if (p.type === 'date' && typeof v === 'string' && v) {
      const d = parseDate(v)
      if (d) dates.push({ key: p.id, label: shortDate(d), overdue: isOverdue(d) })
    } else if (p.type === 'assignee' && typeof v === 'string' && v) {
      assigneeId = v
    }
  }

  const assignee = assigneeId ? members?.find((m) => m.id === assigneeId) : undefined
  const total = card.checklist.length
  const done = card.checklist.reduce((n, i) => n + (i.done ? 1 : 0), 0)
  const complete = total > 0 && done === total
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const hasMeta = chips.length > 0 || dates.length > 0 || !!assigneeId

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
          {chips.map((t) => (
            <Tag key={t.key} colorKey={t.color}>
              {t.label}
            </Tag>
          ))}
          {dates.map((d) => (
            <span
              key={d.key}
              className="rounded px-1.5 py-0.5 text-2xs font-medium"
              style={{
                backgroundColor: 'var(--color-panel)',
                color: d.overdue ? 'var(--board-red-fg)' : 'var(--color-text-dim)',
              }}
            >
              {d.label}
            </span>
          ))}
          {/* TODO(ds): Avatar — card assignee circle; kept custom for the '?'
              unknown-member fallback and its hard-coded #4b4b56 fill. */}
          {assigneeId && (
            <span
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white"
              title={assignee?.display_name ?? 'Unknown'}
              style={{ backgroundColor: assignee ? userColor(assignee.id) : '#4b4b56' }}
            >
              {assignee ? initials(assignee.display_name) : '?'}
            </span>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="mt-2 flex items-center gap-2" title={`${done} of ${total} done`}>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke={complete ? 'var(--board-green-fg)' : 'var(--color-text-faint)'}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
            aria-hidden
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-panel)]">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${pct}%`,
                backgroundColor: complete ? 'var(--board-green-fg)' : 'var(--color-accent)',
              }}
            />
          </div>
          <span className="shrink-0 text-3xs font-medium tabular-nums text-[var(--color-text-faint)]">
            {done}/{total}
          </span>
        </div>
      )}
    </div>
  )
}

export const BoardCard = memo(BoardCardImpl)
