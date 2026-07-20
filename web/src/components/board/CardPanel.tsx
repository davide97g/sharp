import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { BoardCardData, BoardProperty } from '../../lib/boardDoc'
import { deleteCard, setCardValue, updateCardField } from '../../lib/boardDoc'
import type { ChannelMember } from '../../lib/types'
import { AssigneeControl, DateControl, MultiSelectControl, SelectControl } from './PropertyControls'

export function CardPanel({
  card,
  properties,
  members,
  ydoc,
  canEdit,
  onClose,
}: {
  card: BoardCardData
  properties: BoardProperty[]
  members: ChannelMember[] | undefined
  ydoc: Y.Doc
  canEdit: boolean
  onClose: () => void
}) {
  const [title, setTitle] = useState(card.title)
  const [description, setDescription] = useState(card.description)
  const titleFocused = useRef(false)
  const descFocused = useRef(false)
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror remote edits when the field isn't being typed in locally.
  useEffect(() => {
    if (!titleFocused.current) setTitle(card.title)
  }, [card.title])
  useEffect(() => {
    if (!descFocused.current) setDescription(card.description)
  }, [card.description])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function onTitle(v: string) {
    setTitle(v)
    if (titleTimer.current) clearTimeout(titleTimer.current)
    titleTimer.current = setTimeout(() => updateCardField(ydoc, card.id, 'title', v), 300)
  }
  function onDesc(v: string) {
    setDescription(v)
    if (descTimer.current) clearTimeout(descTimer.current)
    descTimer.current = setTimeout(() => updateCardField(ydoc, card.id, 'description', v), 300)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal aria-label="Card">
      <div className="flex-1" onClick={onClose} />
      <aside className="flex w-full max-w-[420px] flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)] shadow-2xl max-sm:max-w-none">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4">
          <span className="text-sm font-semibold text-[var(--color-text-dim)]">Card</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <textarea
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            onFocus={() => (titleFocused.current = true)}
            onBlur={() => (titleFocused.current = false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
            readOnly={!canEdit}
            rows={1}
            placeholder="Untitled"
            className="mb-5 w-full resize-none bg-transparent text-xl font-bold leading-tight text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
          />

          <div className="space-y-3">
            {properties.map((p) => (
              <div key={p.id} className="grid grid-cols-[7rem_1fr] items-start gap-3">
                <div className="pt-1.5 text-xs font-medium text-[var(--color-text-faint)]">{p.name}</div>
                <div>
                  <PropertyControl
                    property={p}
                    card={card}
                    members={members}
                    canEdit={canEdit}
                    onChange={(v) => setCardValue(ydoc, card.id, p.id, v)}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6">
            <div className="mb-1.5 text-xs font-medium text-[var(--color-text-faint)]">Description</div>
            <textarea
              value={description}
              onChange={(e) => onDesc(e.target.value)}
              onFocus={() => (descFocused.current = true)}
              onBlur={() => (descFocused.current = false)}
              readOnly={!canEdit}
              rows={5}
              placeholder={canEdit ? 'Add a description…' : ''}
              className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
        </div>

        {canEdit && (
          <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-3">
            <button
              type="button"
              onClick={() => {
                deleteCard(ydoc, card.id)
                onClose()
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[#e05a7d] hover:bg-[#e05a7d]/10"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
              Delete card
            </button>
          </div>
        )}
      </aside>
    </div>
  )
}

function PropertyControl({
  property,
  card,
  members,
  canEdit,
  onChange,
}: {
  property: BoardProperty
  card: BoardCardData
  members: ChannelMember[] | undefined
  canEdit: boolean
  onChange: (value: string | string[] | null) => void
}) {
  const v = card.values[property.id]
  switch (property.type) {
    case 'select':
      return (
        <SelectControl
          options={property.options ?? []}
          value={typeof v === 'string' ? v : undefined}
          onChange={onChange}
          disabled={!canEdit}
        />
      )
    case 'multiSelect':
      return (
        <MultiSelectControl
          options={property.options ?? []}
          value={Array.isArray(v) ? v : []}
          onChange={onChange}
          disabled={!canEdit}
        />
      )
    case 'date':
      return <DateControl value={typeof v === 'string' ? v : undefined} onChange={onChange} disabled={!canEdit} />
    case 'assignee':
      return (
        <AssigneeControl
          members={members}
          value={typeof v === 'string' ? v : undefined}
          onChange={onChange}
          disabled={!canEdit}
        />
      )
  }
}
