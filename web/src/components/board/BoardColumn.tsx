import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import * as Y from 'yjs'
import type { BoardProperty } from '../../lib/boardDoc'
import { createCard, deleteOption, updateOption } from '../../lib/boardDoc'
import { colorOf } from '../../lib/boardColors'
import { between } from '../../lib/fracIndex'
import type { ChannelMember } from '../../lib/types'
import { BoardCard } from './BoardCard'
import { SelectOptionEditor } from './SelectOptionEditor'
import type { BoardColumnData, useBoardDnd } from './useBoardDnd'
import { Popover } from '../../ui'

type Dnd = ReturnType<typeof useBoardDnd>

export function BoardColumn({
  column,
  properties,
  members,
  ydoc,
  groupByPropertyId,
  canEdit,
  dropIndex,
  dnd,
  onOpenCard,
}: {
  column: BoardColumnData
  properties: BoardProperty[]
  members: ChannelMember[] | undefined
  ydoc: Y.Doc
  groupByPropertyId: string | null
  canEdit: boolean
  dropIndex: number | null
  dnd: Dnd
  onOpenCard: (cardId: string) => void
}) {
  const isNoStatus = column.optionId === null
  const [menuOpen, setMenuOpen] = useState(false)
  const [composing, setComposing] = useState<'top' | 'bottom' | null>(null)
  const [draft, setDraft] = useState('')

  const swatch = colorOf(column.color)

  const columnRef = useCallback(
    (el: HTMLElement | null) => dnd.registerColumn(column.key, el),
    [dnd, column.key],
  )

  function submitDraft(where: 'top' | 'bottom') {
    const title = draft.trim()
    if (!title) return
    const first = column.cards[0]
    const last = column.cards[column.cards.length - 1]
    const order =
      where === 'top' ? between(null, first?.order ?? null) : between(last?.order ?? null, null)
    createCard(ydoc, { title, order, statusOptionId: column.optionId })
    setDraft('')
  }

  // Build the card list, threading the drop-insertion line through at the right
  // position (counted over the non-dragged cards, matching the DnD index space).
  const items: ReactNode[] = []
  const line = (key: string) => (
    <div key={key} className="mx-0.5 my-0.5 h-0.5 rounded-full bg-[var(--color-accent)]" />
  )
  let nonDragged = 0
  let placed = false
  for (const card of column.cards) {
    if (!placed && dropIndex !== null && nonDragged === dropIndex) {
      items.push(line('drop-line'))
      placed = true
    }
    items.push(
      <BoardCard
        key={card.id}
        card={card}
        properties={properties}
        groupByPropertyId={groupByPropertyId}
        members={members}
        canEdit={canEdit}
        dragging={card.id === dnd.dragCardId}
        onOpen={onOpenCard}
        onPointerDown={dnd.startCardDrag}
        consumeSuppressClick={dnd.consumeSuppressClick}
        registerCard={dnd.registerCard}
      />,
    )
    if (card.id !== dnd.dragCardId) nonDragged++
  }
  if (!placed && dropIndex !== null && nonDragged === dropIndex) items.push(line('drop-line'))

  const dimmed = dnd.dragOptionId === column.optionId && column.optionId !== null

  return (
    <div
      ref={columnRef}
      className={`flex w-[280px] shrink-0 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] ${
        dimmed ? 'opacity-40' : ''
      }`}
    >
      {/* header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        {/* TODO(ds): Tag — header pill is also the column drag handle (onPointerDown)
            with a no-background "No status" variant; kept custom (Tag has no event
            passthrough and is text-2xs/rounded vs this text-xs/rounded-md). */}
        <span
          onPointerDown={(e) => {
            if (!isNoStatus) dnd.startColumnDrag(e, column.optionId as string)
          }}
          className={`flex min-w-0 select-none items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold ${
            canEdit && !isNoStatus ? 'cursor-grab active:cursor-grabbing' : ''
          }`}
          style={isNoStatus ? undefined : { backgroundColor: swatch.bg, color: swatch.fg }}
        >
          <span className={`truncate ${isNoStatus ? 'text-[var(--color-text-faint)]' : ''}`}>
            {isNoStatus ? 'No status' : column.label || 'Untitled'}
          </span>
        </span>
        <span className="text-xs text-[var(--color-text-faint)]">{column.cards.length}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {canEdit && (
            <button
              type="button"
              onClick={() => setComposing((c) => (c === 'top' ? null : 'top'))}
              aria-label="Add card"
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
          {canEdit && !isNoStatus && (
            <Popover
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              align="end"
              width="w-72"
              trigger={
                <button
                  type="button"
                  onClick={() => setMenuOpen((o) => !o)}
                  aria-label="Column options"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                  </svg>
                </button>
              }
            >
              <div className="p-1">
                <SelectOptionEditor
                  option={{ id: column.optionId as string, label: column.label, color: column.color }}
                  autoFocus
                  onLabel={(label) => {
                    if (groupByPropertyId)
                      updateOption(ydoc, groupByPropertyId, column.optionId as string, { label })
                  }}
                  onColor={(color) => {
                    if (groupByPropertyId)
                      updateOption(ydoc, groupByPropertyId, column.optionId as string, { color })
                  }}
                  onDelete={() => {
                    if (groupByPropertyId)
                      deleteOption(ydoc, groupByPropertyId, column.optionId as string)
                    setMenuOpen(false)
                  }}
                />
              </div>
            </Popover>
          )}
        </div>
      </div>

      {/* cards */}
      <div className="flex min-h-[8px] flex-col gap-1.5 px-2 pb-2">
        {composing === 'top' && (
          <Composer
            value={draft}
            onChange={setDraft}
            onSubmit={() => submitDraft('top')}
            onCancel={() => {
              setComposing(null)
              setDraft('')
            }}
          />
        )}
        {items}
      </div>

      {/* bottom add */}
      {canEdit && (
        <div className="px-2 pb-3">
          {composing === 'bottom' ? (
            <Composer
              value={draft}
              onChange={setDraft}
              onSubmit={() => submitDraft('bottom')}
              onCancel={() => {
                setComposing(null)
                setDraft('')
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setComposing('bottom')}
              className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text-dim)]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              New
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Composer({
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onSubmit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      onBlur={() => {
        if (!value.trim()) onCancel()
      }}
      rows={2}
      placeholder="Card title…"
      className="w-full resize-none rounded-lg border border-[var(--color-accent)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
    />
  )
}
