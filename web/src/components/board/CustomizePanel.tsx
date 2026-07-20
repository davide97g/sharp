import { useState } from 'react'
import * as Y from 'yjs'
import { Modal } from '../Modal'
import type { BoardProperty, BoardPropertyType } from '../../lib/boardDoc'
import {
  addOption,
  addProperty,
  deleteOption,
  deleteProperty,
  renameProperty,
  updateOption,
} from '../../lib/boardDoc'
import { nextColor } from '../../lib/boardColors'
import { SelectOptionEditor } from './SelectOptionEditor'

const TYPE_LABEL: Record<BoardPropertyType, string> = {
  select: 'Select',
  multiSelect: 'Multi-select',
  date: 'Date',
  assignee: 'Person',
}

const ADDABLE: BoardPropertyType[] = ['select', 'multiSelect', 'date', 'assignee']

export function CustomizePanel({
  ydoc,
  properties,
  groupByPropertyId,
  onClose,
}: {
  ydoc: Y.Doc
  properties: BoardProperty[]
  groupByPropertyId: string | null
  onClose: () => void
}) {
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<BoardPropertyType>('select')

  function add() {
    const name = newName.trim()
    if (!name) return
    addProperty(ydoc, { type: newType, name })
    setNewName('')
    setNewType('select')
  }

  return (
    <Modal title="Customize properties" onClose={onClose} wide>
      <div className="space-y-3">
        {properties.map((p) => {
          const isGroupBy = p.id === groupByPropertyId
          const hasOptions = p.type === 'select' || p.type === 'multiSelect'
          return (
            <div key={p.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3">
              <div className="flex items-center gap-2">
                <input
                  value={p.name}
                  onChange={(e) => renameProperty(ydoc, p.id, e.target.value)}
                  placeholder="Property name"
                  className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-sm font-medium focus:border-[var(--color-accent)] focus:outline-none"
                />
                <span className="shrink-0 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-faint)]">
                  {TYPE_LABEL[p.type]}
                </span>
                {isGroupBy ? (
                  <span
                    title="The status property drives the board columns and can't be removed."
                    className="flex h-7 w-7 shrink-0 items-center justify-center text-[var(--color-text-faint)]"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                    </svg>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => deleteProperty(ydoc, p.id)}
                    aria-label="Delete property"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[#e05a7d]"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                  </button>
                )}
              </div>

              {hasOptions && (
                <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
                  {(p.options ?? []).map((o) => (
                    <SelectOptionEditor
                      key={o.id}
                      option={o}
                      onLabel={(label) => updateOption(ydoc, p.id, o.id, { label })}
                      onColor={(color) => updateOption(ydoc, p.id, o.id, { color })}
                      onDelete={() => deleteOption(ydoc, p.id, o.id)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => addOption(ydoc, p.id, { label: '', color: nextColor(p.options?.length ?? 0) })}
                    className="flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Add option
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-4 border-t border-[var(--color-border)] pt-4">
        <div className="mb-2 text-xs font-medium text-[var(--color-text-dim)]">Add a property</div>
        <div className="flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add()
              }
            }}
            placeholder="Name"
            className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as BoardPropertyType)}
            className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1.5 text-sm focus:border-[var(--color-accent)] focus:outline-none"
          >
            {ADDABLE.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={add}
            disabled={!newName.trim()}
            className="shrink-0 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  )
}
