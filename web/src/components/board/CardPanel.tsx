import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { BoardCardData, BoardProperty, CardDocRef, ChecklistItem } from '../../lib/boardDoc'
import {
  addCardDocRef,
  addChecklistItem,
  deleteCard,
  deleteCardDocRef,
  deleteChecklistItem,
  setCardValue,
  updateCardField,
  updateChecklistItem,
} from '../../lib/boardDoc'
import { api } from '../../lib/api'
import { navigateTo } from '../../lib/nav'
import { toastError } from '../../lib/toast'
import type { ChannelMember, DocKind } from '../../lib/types'
import { docRoute } from '../docs/DocSurface'
import { AssigneeControl, DateControl, MultiSelectControl, SelectControl } from './PropertyControls'
import { CloseIcon, IconButton, Popover, SearchInput, useDismiss } from '../../ui'

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
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const descRef = useRef<HTMLTextAreaElement>(null)
  const asideRef = useRef<HTMLElement>(null)

  // Grow the title textarea to fit its content so long, wrapped titles aren't
  // clipped to a single line.
  useEffect(() => {
    const el = titleRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [title])

  // Same for the description: it starts at five rows and grows with the text
  // instead of turning into a small scroll box.
  useEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [description])

  // Mirror remote edits when the field isn't being typed in locally.
  useEffect(() => {
    if (!titleFocused.current) setTitle(card.title)
  }, [card.title])
  useEffect(() => {
    if (!descFocused.current) setDescription(card.description)
  }, [card.description])

  // Escape-to-close via the shared hook; the flex-1 backdrop keeps its explicit
  // click-to-close so outside handling stays scoped to this overlay.
  useDismiss({ ref: asideRef, onClose, outside: false })

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
    // TODO(ds): SlideOver — kept custom because this panel is bg-ink (not bg-panel),
    // z-40, backdrop-less inline (not portaled with a scrim); adopts useDismiss +
    // IconButton pieces instead.
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal aria-label="Card">
      <div className="flex-1" onClick={onClose} />
      <aside
        ref={asideRef}
        className="flex w-full max-w-[420px] flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)] shadow-2xl max-sm:max-w-none"
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4">
          <span className="text-sm font-semibold text-[var(--color-text-dim)]">Card</span>
          <IconButton label="Close" onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <textarea
            ref={titleRef}
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
            className="mb-5 w-full resize-none overflow-hidden break-words bg-transparent text-xl font-bold leading-tight text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
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
              ref={descRef}
              value={description}
              onChange={(e) => onDesc(e.target.value)}
              onFocus={() => (descFocused.current = true)}
              onBlur={() => (descFocused.current = false)}
              readOnly={!canEdit}
              rows={5}
              placeholder={canEdit ? 'Add a description…' : ''}
              className="min-h-[7.5rem] w-full resize-none overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>

          <DocRefs refs={card.docRefs} cardId={card.id} ydoc={ydoc} canEdit={canEdit} />

          <Checklist items={card.checklist} cardId={card.id} ydoc={ydoc} canEdit={canEdit} />
        </div>

        {canEdit && (
          <div className="shrink-0 border-t border-[var(--color-border)] px-4 py-3">
            {/* TODO(ds): Button has no danger-outline variant; kept custom, hex→danger tokens. */}
            <button
              type="button"
              onClick={() => {
                deleteCard(ydoc, card.id)
                onClose()
              }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-danger-fg hover:bg-danger-soft"
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

// ---- doc references --------------------------------------------------------
//
// A card can point at docs, canvases and boards. Only the id/title/kind are
// stored on the card (see boardDoc.ts) — the picker searches the docs API, so
// permissions stay the server's business and the board doc stays self-contained.

const KIND_ICON: Record<DocKind, string> = { doc: '📄', canvas: '🎨', board: '🗂️' }
const KIND_LABEL: Record<DocKind, string> = { doc: 'Doc', canvas: 'Canvas', board: 'Board' }

type PickerRow = { id: string; title: string; kind: DocKind; icon: string; sub?: string }

function DocRefs({
  refs,
  cardId,
  ydoc,
  canEdit,
}: {
  refs: CardDocRef[]
  cardId: string
  ydoc: Y.Doc
  canEdit: boolean
}) {
  const [picking, setPicking] = useState(false)

  if (refs.length === 0 && !canEdit) return null

  return (
    <div className="mt-6">
      <div className="mb-2 text-xs font-medium text-[var(--color-text-faint)]">Docs</div>

      <div className="space-y-0.5">
        {refs.map((ref) => (
          <div
            key={ref.id}
            className="group/ref flex items-center gap-2 rounded-md px-1 py-1 hover:bg-[var(--color-panel-2)]"
          >
            <button
              type="button"
              onClick={() => navigateTo(docRoute(ref.kind, ref.docId))}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span aria-hidden className="shrink-0 text-sm">
                {ref.icon || KIND_ICON[ref.kind]}
              </span>
              <span className="truncate text-sm text-[var(--color-text)]">
                {ref.title || 'Untitled'}
              </span>
              <span className="shrink-0 text-2xs text-[var(--color-text-faint)]">
                {KIND_LABEL[ref.kind]}
              </span>
            </button>
            {canEdit && (
              <button
                type="button"
                onClick={() => deleteCardDocRef(ydoc, cardId, ref.id)}
                aria-label={`Remove ${ref.title || 'reference'}`}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:text-danger-fg focus:opacity-100 group-hover/ref:opacity-100"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <Popover
          open={picking}
          onClose={() => setPicking(false)}
          width="w-72"
          role="dialog"
          aria-label="Link a doc"
          trigger={
            <button
              type="button"
              onClick={() => setPicking((v) => !v)}
              className="mt-1 flex items-center gap-2 rounded-md px-1 py-1 text-sm text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
              Link a doc
            </button>
          }
        >
          <DocPicker
            existing={refs.map((r) => r.docId)}
            onPick={(row) => {
              addCardDocRef(ydoc, cardId, {
                docId: row.id,
                title: row.title,
                kind: row.kind,
                icon: row.icon,
              })
              setPicking(false)
            }}
          />
        </Popover>
      )}
    </div>
  )
}

function DocPicker({
  existing,
  onPick,
}: {
  existing: string[]
  onPick: (row: PickerRow) => void
}) {
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<PickerRow[]>([])
  const [loading, setLoading] = useState(true)
  const alreadyLinked = useMemo(() => new Set(existing), [existing])

  // Empty query lists the workspace's recent docs; typing searches. Debounced so
  // a fast typist doesn't fire a request per keystroke.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(
      () => {
        const q = query.trim()
        const request = q
          ? api.docSearch(q, 12).then((r) =>
              r.results.map((d) => ({
                id: d.id,
                title: d.title || 'Untitled',
                kind: d.kind,
                icon: d.icon,
                sub: d.channel_name ? `#${d.channel_name}` : undefined,
              })),
            )
          : api.recentDocs(undefined, 12).then((r) =>
              r.docs.map(({ doc, channel_name }) => ({
                id: doc.id,
                title: doc.title || 'Untitled',
                kind: doc.kind,
                icon: doc.icon,
                sub: channel_name ? `#${channel_name}` : undefined,
              })),
            )
        request
          .then((next) => {
            if (!cancelled) setRows(next)
          })
          .catch((e) => {
            if (!cancelled && e instanceof Error) toastError(e.message)
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      },
      query ? 180 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const visible = rows.filter((r) => !alreadyLinked.has(r.id))

  return (
    <div className="p-2">
      <SearchInput
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search docs, canvases, boards…"
        autoFocus
      />
      <div className="mt-2 max-h-64 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-2 py-3 text-xs text-[var(--color-text-faint)]">
            {loading ? 'Searching…' : 'Nothing to link'}
          </div>
        ) : (
          visible.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => onPick(row)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-panel-2)]"
            >
              <span aria-hidden className="shrink-0 text-sm">
                {row.icon || KIND_ICON[row.kind]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--color-text)]">{row.title}</span>
                {row.sub && (
                  <span className="block truncate text-2xs text-[var(--color-text-faint)]">
                    {row.sub}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-2xs text-[var(--color-text-faint)]">
                {KIND_LABEL[row.kind]}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

function Checklist({
  items,
  cardId,
  ydoc,
  canEdit,
}: {
  items: ChecklistItem[]
  cardId: string
  ydoc: Y.Doc
  canEdit: boolean
}) {
  const [draft, setDraft] = useState('')
  const total = items.length
  const done = items.reduce((n, i) => n + (i.done ? 1 : 0), 0)
  const complete = total > 0 && done === total
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  function add() {
    const text = draft.trim()
    if (!text) return
    addChecklistItem(ydoc, cardId, text)
    setDraft('')
  }

  // Nothing to show and can't add: hide the section entirely.
  if (total === 0 && !canEdit) return null

  return (
    <div className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-[var(--color-text-faint)]">Checklist</div>
        {total > 0 && (
          <div className="text-2xs font-medium tabular-nums text-[var(--color-text-faint)]">
            {done}/{total}
          </div>
        )}
      </div>

      {total > 0 && (
        <div
          className="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--color-panel-2)]"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Checklist ${done} of ${total} done`}
        >
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${pct}%`,
              backgroundColor: complete ? 'var(--board-green-fg)' : 'var(--color-accent)',
            }}
          />
        </div>
      )}

      <div className="space-y-0.5">
        {items.map((item) => (
          <ChecklistRow
            key={item.id}
            item={item}
            canEdit={canEdit}
            onToggle={() => updateChecklistItem(ydoc, cardId, item.id, { done: !item.done })}
            onText={(text) => updateChecklistItem(ydoc, cardId, item.id, { text })}
            onDelete={() => deleteChecklistItem(ydoc, cardId, item.id)}
          />
        ))}
      </div>

      {canEdit && (
        <div className="mt-1 flex items-center gap-2 pl-0.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="shrink-0 text-[var(--color-text-faint)]" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            onBlur={add}
            placeholder="Add an item"
            className="min-w-0 flex-1 bg-transparent py-1 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
          />
        </div>
      )}
    </div>
  )
}

function ChecklistRow({
  item,
  canEdit,
  onToggle,
  onText,
  onDelete,
}: {
  item: ChecklistItem
  canEdit: boolean
  onToggle: () => void
  onText: (text: string) => void
  onDelete: () => void
}) {
  return (
    <div className="group/item flex items-center gap-2 rounded-md px-0.5 hover:bg-[var(--color-panel-2)]">
      <button
        type="button"
        onClick={onToggle}
        disabled={!canEdit}
        role="checkbox"
        aria-checked={item.done}
        aria-label={item.done ? 'Mark not done' : 'Mark done'}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
          item.done
            ? 'border-transparent bg-[var(--color-accent)] text-white'
            : 'border-[var(--color-border)] text-transparent hover:border-[var(--color-accent)]'
        } ${canEdit ? '' : 'cursor-default'}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </button>
      <input
        value={item.text}
        onChange={(e) => onText(e.target.value)}
        readOnly={!canEdit}
        placeholder="Item"
        className={`min-w-0 flex-1 bg-transparent py-1 text-sm focus:outline-none ${
          item.done
            ? 'text-[var(--color-text-faint)] line-through'
            : 'text-[var(--color-text)]'
        } placeholder:text-[var(--color-text-faint)]`}
      />
      {canEdit && (
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete item"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] opacity-0 hover:text-danger-fg focus:opacity-100 group-hover/item:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  )
}
