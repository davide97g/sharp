// Keyboard-filterable dropdown menus for task properties — the Linear pattern:
// click (or hotkey) opens a small palette, type to filter, Enter/click to pick.
import { effectiveNicknames } from '../../lib/displayName'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../../store'
import { colorOf } from '../../lib/boardColors'
import type { Project, TaskLabel, TaskPriority } from '../../lib/types'
import { Avatar } from '../Avatar'
import { Button, CheckIcon, CloseIcon, IconButton, Input, MenuItem, Popover } from '../../ui'
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

  // Panel chrome + positioning + dismiss come from the Popover in PickerShell;
  // this renders only the palette content (search + filtered list + footer).
  return (
    <>
      <Input
        ref={inputRef}
        uiSize="sm"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        className="mb-1"
      />
      <div className="max-h-64 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="px-3 py-2 text-sm text-text-faint">No matches</div>
        )}
        {filtered.map((item, i) => (
          <MenuItem
            key={item.id}
            active={i === cursor}
            onMouseEnter={() => setCursor(i)}
            onClick={() => onPick(item.id)}
            icon={item.icon && <span className="flex w-4 shrink-0 justify-center">{item.icon}</span>}
            trailing={item.selected ? <CheckIcon size={14} className="text-accent" /> : undefined}
            className={item.selected ? 'text-accent-hover' : undefined}
          >
            {item.label}
          </MenuItem>
        ))}
      </div>
      {footer}
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
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      width="w-60"
      trigger={
        <Button
          variant="ghost"
          size="sm"
          className="min-h-9 font-normal"
          onClick={() => setOpen(!open)}
        >
          {trigger}
        </Button>
      }
    >
      {children}
    </Popover>
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
  const nicknames = useStore(effectiveNicknames)
  const [open, setOpen] = useState(false)
  const current = assigneeId ? users[assigneeId] : null
  const currentLabel = current
    ? nicknames[current.id]?.trim() || current.display_name
    : null
  const UNASSIGNED = '__none__'
  return (
    <PickerShell
      open={open}
      setOpen={setOpen}
      trigger={
        current && currentLabel ? (
          <>
            <Avatar id={current.id} name={current.display_name} size={16} />
            <span>{currentLabel}</span>
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
            .map((u) => ({
              u,
              label: nicknames[u.id]?.trim() || u.display_name,
            }))
            .sort((a, b) => a.label.localeCompare(b.label))
            .map(({ u, label }) => ({
              id: u.id,
              label,
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
          <div className="mt-1 flex items-center gap-1 border-t border-border pt-1.5">
            <Input
              uiSize="sm"
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
              className="min-w-0 flex-1"
            />
            <Button variant="ghost" size="xs" onClick={() => void createLabel()}>
              Add
            </Button>
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
        <IconButton label="Clear due date" onClick={() => onPick(null)}>
          <CloseIcon size={14} />
        </IconButton>
      )}
    </div>
  )
}

export type { TaskLabel }
