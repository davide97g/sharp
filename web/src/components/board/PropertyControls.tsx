import { useState, type ReactNode } from 'react'
import type { BoardOption } from '../../lib/boardDoc'
import { colorOf } from '../../lib/boardColors'
import type { ChannelMember } from '../../lib/types'
import { initials, userColor } from '../../lib/util'
import { Popover, Tag } from '../../ui'

// Small popover shell shared by the select/assignee controls: a trigger that
// toggles a panel, closing on outside-click (ui Popover adds Escape too).
function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align={align === 'right' ? 'end' : 'start'}
      width="w-full min-w-[12rem]"
      className="max-h-64 overflow-y-auto"
      trigger={
        <button type="button" onClick={() => setOpen((o) => !o)} className="block w-full text-left">
          {trigger(open)}
        </button>
      }
    >
      {children(() => setOpen(false))}
    </Popover>
  )
}

function OptionPill({ option }: { option: BoardOption }) {
  return <Tag colorKey={option.color}>{option.label || 'Untitled'}</Tag>
}

const emptyBox =
  'flex min-h-8 w-full items-center rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-sm'

export function SelectControl({
  options,
  value,
  onChange,
  disabled,
}: {
  options: BoardOption[]
  value: string | undefined
  onChange: (optionId: string | null) => void
  disabled?: boolean
}) {
  const selected = options.find((o) => o.id === value)
  if (disabled) {
    return (
      <div className={emptyBox}>
        {selected ? <OptionPill option={selected} /> : <span className="text-[var(--color-text-faint)]">Empty</span>}
      </div>
    )
  }
  return (
    <Dropdown
      trigger={() => (
        <div className={`${emptyBox} hover:border-[var(--color-accent)]`}>
          {selected ? <OptionPill option={selected} /> : <span className="text-[var(--color-text-faint)]">Empty</span>}
        </div>
      )}
    >
      {(close) => (
        <>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => {
                onChange(o.id)
                close()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-panel-2)]"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: colorOf(o.color).fg }} />
              <span className="min-w-0 flex-1 truncate text-sm">{o.label || 'Untitled'}</span>
              {o.id === value && <Check />}
            </button>
          ))}
          {selected && (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                close()
              }}
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              Clear
            </button>
          )}
          {options.length === 0 && (
            <div className="px-2 py-2 text-xs text-[var(--color-text-faint)]">No options yet.</div>
          )}
        </>
      )}
    </Dropdown>
  )
}

export function MultiSelectControl({
  options,
  value,
  onChange,
  disabled,
}: {
  options: BoardOption[]
  value: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}) {
  function toggle(id: string) {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  }
  if (disabled) {
    const chosen = options.filter((o) => value.includes(o.id))
    return (
      <div className="flex flex-wrap gap-1.5">
        {chosen.length ? (
          chosen.map((o) => <OptionPill key={o.id} option={o} />)
        ) : (
          <span className="text-sm text-[var(--color-text-faint)]">Empty</span>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.length === 0 && (
        <span className="text-sm text-[var(--color-text-faint)]">No options yet.</span>
      )}
      {options.map((o) => {
        const on = value.includes(o.id)
        const c = colorOf(o.color)
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => toggle(o.id)}
            className="max-w-full truncate rounded px-1.5 py-0.5 text-xs font-medium transition-opacity"
            style={
              on
                ? { backgroundColor: c.bg, color: c.fg }
                : { backgroundColor: 'var(--color-panel-2)', color: 'var(--color-text-faint)' }
            }
          >
            {o.label || 'Untitled'}
          </button>
        )
      })}
    </div>
  )
}

export function DateControl({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined
  onChange: (v: string | null) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-70 [color-scheme:dark]"
      />
      {!disabled && value && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-xs text-[var(--color-text-faint)] hover:text-[var(--color-text-dim)]"
        >
          Clear
        </button>
      )}
    </div>
  )
}

export function AssigneeControl({
  members,
  value,
  onChange,
  disabled,
}: {
  members: ChannelMember[] | undefined
  value: string | undefined
  onChange: (userId: string | null) => void
  disabled?: boolean
}) {
  const selected = value ? members?.find((m) => m.id === value) : undefined
  // TODO(ds): Avatar — member-picker circle; kept custom for the '?' unknown-member
  // fallback and its hard-coded #4b4b56 fill (no Avatar equivalent).
  const display = value ? (
    <span className="flex items-center gap-2">
      <span
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white"
        style={{ backgroundColor: selected ? userColor(selected.id) : '#4b4b56' }}
      >
        {selected ? initials(selected.display_name) : '?'}
      </span>
      <span className="truncate text-sm">{selected?.display_name ?? 'Unknown'}</span>
    </span>
  ) : (
    <span className="text-[var(--color-text-faint)]">Empty</span>
  )

  if (disabled) return <div className={emptyBox}>{display}</div>

  return (
    <Dropdown trigger={() => <div className={`${emptyBox} hover:border-[var(--color-accent)]`}>{display}</div>}>
      {(close) => (
        <>
          {(members ?? []).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                onChange(m.id)
                close()
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-panel-2)]"
            >
              {/* TODO(ds): Avatar — member-picker circle, id-based color already. */}
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-3xs font-semibold text-white"
                style={{ backgroundColor: userColor(m.id) }}
              >
                {initials(m.display_name)}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
              {m.id === value && <Check />}
            </button>
          ))}
          {value && (
            <button
              type="button"
              onClick={() => {
                onChange(null)
                close()
              }}
              className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
            >
              Clear
            </button>
          )}
          {(members?.length ?? 0) === 0 && (
            <div className="px-2 py-2 text-xs text-[var(--color-text-faint)]">No members.</div>
          )}
        </>
      )}
    </Dropdown>
  )
}

function Check() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-hover)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
