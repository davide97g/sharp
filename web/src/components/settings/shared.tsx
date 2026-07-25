// Controls used by more than one settings tab.
//
// Deliberately small: a control belongs here only once a second tab needs it. Anything
// generic enough for the whole app belongs in web/src/ui/ instead — see
// docs/DESIGN_SYSTEM.md. These three sit in between: they encode the settings-row
// layout (label + description on the left, control on the right) rather than a
// general-purpose primitive.

import { Button } from '../../ui'
import { Toggle } from '../Toggle'

/** Label + description + switch, the shape used across these settings panes. */
export function ToggleRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">{title}</div>
        {description && <div className="text-2xs text-text-faint">{description}</div>}
      </div>
      <DockAutoHideSwitch checked={checked} onChange={onChange} />
    </div>
  )
}

/** Segmented row of mutually exclusive options. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex gap-1 rounded-lg border border-border bg-panel-2 p-1"
    >
      {options.map((o) => (
        <Button
          key={String(o.value)}
          role="radio"
          aria-checked={value === o.value}
          size="sm"
          variant={value === o.value ? 'primary' : 'ghost'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}

export function DockAutoHideSwitch({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return <Toggle checked={checked} onChange={onChange} label="Automatically hide the dock" />
}
