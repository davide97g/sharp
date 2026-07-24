import { colorOf, PALETTE_KEYS } from '../../lib/boardColors'
import type { BoardOption } from '../../lib/boardDoc'

// One editable option row: label input + an 8-swatch color grid + delete.
// Shared by CustomizePanel and a column header's recolor menu.
export function SelectOptionEditor({
  option,
  onLabel,
  onColor,
  onDelete,
  autoFocus,
}: {
  option: BoardOption
  onLabel: (label: string) => void
  onColor: (color: string) => void
  onDelete: () => void
  autoFocus?: boolean
}) {
  return (
    <div className="flex items-center gap-2">
      <span
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: colorOf(option.color).fg }}
      />
      <input
        autoFocus={autoFocus}
        value={option.label}
        onChange={(e) => onLabel(e.target.value)}
        placeholder="Option"
        className="min-w-0 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-2 py-1 text-sm focus:border-[var(--color-accent)] focus:outline-none"
      />
      <div className="flex shrink-0 items-center gap-1">
        {PALETTE_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            title={colorOf(k).label}
            onClick={() => onColor(k)}
            className={`h-4 w-4 rounded-full ring-offset-1 ring-offset-[var(--color-panel)] ${
              option.color === k ? 'ring-2 ring-[var(--color-text-dim)]' : ''
            }`}
            style={{ backgroundColor: colorOf(k).fg }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete option"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-danger-fg"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        </svg>
      </button>
    </div>
  )
}
