// Keyboard-filterable dropdown menus for task properties — the Linear pattern:
// click (or hotkey) opens a small palette, type to filter, Enter/click to pick.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { colorOf } from '../../lib/boardColors'
import type { Project, TaskLabel, TaskPriority } from '../../lib/types'
import { Avatar } from '../Avatar'
import { PRIORITIES, PRIORITY_LABELS, PriorityIcon, StateDot } from './taskUi'

type Item = {
  id: string
  label: string
  icon?: ReactNode
  selected?: boolean
}

export function PickerMenu({
  items,
  onPick,
  onClose,
  placeholder,
  footer,
}: {
  items: Item[]
  onPick: (id: string) => void
  onClose: () => void
  placeholder: string
  footer?: ReactNode
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((i) => i.label.toLowerCase().includes(q))
  }, [items, query])

  useEffect(() => {
    setCursor(0)
  }, [query])

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[cursor]
      if (item) onPick(item.id)
    }
    e.stopPropagation()
  }

  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div className="absolute left-0 top-full z-40 mt-1 w-60 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="mb-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-ink)] px-2 py-1 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
        <div className="max-h-64 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="px-2 py-2 text-xs text-[var(--color-text-faint)]">No matches</div>
          )}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              onClick={() => onPick(item.id)}
              onMouseEnter={() => setCursor(i)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                i === cursor ? 'bg-[var(--color-panel-2)]' : ''
              } ${item.selected ? 'text-[var(--color-accent-hover)]' : 'text-[var(--color-text)]'}`}
            >
              {item.icon && <span className="flex w-4 shrink-0 justify-center">{item.icon}</span>}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.selected && <span className="text-xs">✓</span>}
            </button>
          ))}
        </div>
        {footer}
      </div>
    </>
  )
}

/** Wraps a trigger button + its picker; parent supplies the open state. */
export function PickerShell({
  open,
  setOpen,
  trigger,
  children,
}: {
  open: boolean
  setOpen: (open: boolean) => void
  trigger: ReactNode
  children: ReactNode
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
      >
        {trigger}
      </button>
      {open && children}
    </div>
  )
}

export function StatePicker({
  project,
  stateId,
  onPick,
}: {
  project: Project
  stateId: string
  onPick: (stateId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = project.states.find((s) => s.id === stateId)
  return (
    <PickerShell
      open={open}
      setOpen={setOpen}
      trigger={
        <>
          {current && <StateDot state={current} />}
          <span>{current?.name ?? 'No state'}</span>
        </>
      }
    >
      <PickerMenu
        placeholder="Change state…"
        items={project.states.map((s) => ({
          id: s.id,
          label: s.name,
          icon: <StateDot state={s} />,
          selected: s.id === stateId,
        }))}
        onPick={(id) => {
          setOpen(false)
          if (id !== stateId) onPick(id)
        }}
        onClose={() => setOpen(false)}
      />
    </PickerShell>
  )
}

export function PriorityPicker({
  priority,
  onPick,
}: {
  priority: TaskPriority
  onPick: (p: TaskPriority) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <PickerShell
      open={open}
      setOpen={setOpen}
      trigger={
        <>
          <PriorityIcon p={priority} />
          <span>{PRIORITY_LABELS[priority]}</span>
        </>
      }
    >
      <PickerMenu
        placeholder="Set priority…"
        items={PRIORITIES.map((p) => ({
          id: String(p),
          label: PRIORITY_LABELS[p],
          icon: <PriorityIcon p={p} />,
          selected: p === priority,
        }))}
        onPick={(id) => {
          setOpen(false)
          onPick(Number(id) as TaskPriority)
        }}
        onClose={() => setOpen(false)}
      />
    </PickerShell>
  )
}

export function AssigneePicker({
  assigneeId,
  onPick,
}: {
  assigneeId: string | null
  onPick: (userId: string | null) => void
}) {
  const users = useStore((s) => s.users)
  const [open, setOpen] = useState(false)
  const current = assigneeId ? users[assigneeId] : null
  const UNASSIGNED = '__none__'
  return (
    <PickerShell
      open={open}
      setOpen={setOpen}
      trigger={
        current ? (
          <>
            <Avatar id={current.id} name={current.display_name} size={16} />
            <span>{current.display_name}</span>
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="8" r="4" strokeDasharray="2 2.5" />
              <path d="M4 21c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" strokeDasharray="2 2.5" />
            </svg>
            <span>Unassigned</span>
          </>
        )
      }
    >
      <PickerMenu
        placeholder="Assign to…"
        items={[
          { id: UNASSIGNED, label: 'Unassigned', selected: !assigneeId },
          ...Object.values(users)
            .sort((a, b) => a.display_name.localeCompare(b.display_name))
            .map((u) => ({
              id: u.id,
              label: u.display_name,
              icon: <Avatar id={u.id} name={u.display_name} size={16} />,
              selected: u.id === assigneeId,
            })),
        ]}
        onPick={(id) => {
          setOpen(false)
          onPick(id === UNASSIGNED ? null : id)
        }}
        onClose={() => setOpen(false)}
      />
    </PickerShell>
  )
}

export function LabelsPicker({
  labelIds,
  onChange,
}: {
  labelIds: string[]
  onChange: (labelIds: string[]) => void
}) {
  const labels = useStore((s) => s.taskLabels)
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState('')
  const createLabel = async () => {
    const name = creating.trim()
    if (!name) return
    const { api } = await import('../../lib/api')
    const colors = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'gray']
    const label = await api.tasks.createLabel({
      name,
      color: colors[labels.length % colors.length],
    })
    setCreating('')
    onChange([...labelIds, label.id])
  }
  const selected = labels.filter((l) => labelIds.includes(l.id))
  return (
    <PickerShell
      open={open}
      setOpen={setOpen}
      trigger={
        <>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7.2-7.2a2 2 0 0 0 0-2.8Z" />
            <circle cx="7" cy="7" r="1" fill="currentColor" />
          </svg>
          <span>
            {selected.length === 0
              ? 'Add labels'
              : selected.map((l) => l.name).join(', ')}
          </span>
        </>
      }
    >
      <PickerMenu
        placeholder="Toggle labels…"
        items={labels.map((l) => ({
          id: l.id,
          label: l.name,
          icon: (
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: colorOf(l.color).fg }}
            />
          ),
          selected: labelIds.includes(l.id),
        }))}
        onPick={(id) => {
          onChange(
            labelIds.includes(id) ? labelIds.filter((l) => l !== id) : [...labelIds, id],
          )
        }}
        onClose={() => setOpen(false)}
        footer={
          <div className="mt-1 flex items-center gap-1 border-t border-[var(--color-border)] pt-1.5">
            <input
              value={creating}
              onChange={(e) => setCreating(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void createLabel()
                }
                e.stopPropagation()
              }}
              placeholder="New label…"
              className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-ink)] px-2 py-1 text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
            />
            <button
              onClick={() => void createLabel()}
              className="rounded-md px-2 py-1 text-xs text-[var(--color-accent-hover)] hover:bg-[var(--color-panel-2)]"
            >
              Add
            </button>
          </div>
        }
      />
    </PickerShell>
  )
}

export function DuePicker({
  due,
  onPick,
}: {
  due: string | null
  onPick: (due: string | null) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        value={due ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        className="rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm text-[var(--color-text-dim)] hover:border-[var(--color-border)] focus:border-[var(--color-accent)] focus:outline-none [color-scheme:dark]"
      />
      {due && (
        <button
          onClick={() => onPick(null)}
          title="Clear due date"
          className="rounded px-1 text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
        >
          ✕
        </button>
      )}
    </div>
  )
}

export type { TaskLabel }
