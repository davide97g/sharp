// Shared on/off switch. Track + thumb geometry lives here so every toggle in
// the app renders identically. The thumb is positioned explicitly (left-0.5
// base + a fixed translate) rather than leaning on the browser's static-position
// guess for an absolutely-positioned box, so it can never drift past the edge.

const TRACK = 'relative h-5 w-9 shrink-0 rounded-full transition-colors'
const THUMB = 'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform'

/** Non-interactive track + thumb, for embedding inside an outer control that
 *  already owns the click (e.g. a full-width row button). */
export function ToggleVisual({ checked }: { checked: boolean }) {
  return (
    <span className={`${TRACK} ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}>
      <span className={`${THUMB} ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
    </span>
  )
}

/** Interactive switch. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  describedBy,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  disabled?: boolean
  id?: string
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-default disabled:opacity-50"
    >
      <ToggleVisual checked={checked} />
    </button>
  )
}
