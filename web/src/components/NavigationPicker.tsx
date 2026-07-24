import type { RailPosition } from '../store'

function LayoutThumbnail({ position }: { position: RailPosition }) {
  const bottom = position === 'bottom'
  const top = position === 'top'
  return (
    <span
      aria-hidden="true"
      className="relative block h-16 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]"
    >
      <span
        className={`absolute bg-[var(--color-accent-soft)] ${
          bottom
            ? 'bottom-1 left-2 right-2 h-2 rounded-full'
            : top
              ? 'left-2 right-2 top-1 h-2 rounded-full'
              : 'bottom-2 left-1 top-2 w-2 rounded-full'
        }`}
      />
      <span
        className={`absolute rounded-sm border border-[var(--color-border)] bg-[var(--color-panel)] ${
          bottom
            ? 'bottom-4 left-4 right-2 top-2'
            : top
              ? 'bottom-2 left-4 right-2 top-4'
              : 'bottom-2 left-4 right-2 top-2'
        }`}
      >
        <span className="absolute left-2 right-4 top-2 h-1 rounded-full bg-[var(--color-text-faint)] opacity-50" />
        <span className="absolute left-2 right-7 top-5 h-1 rounded-full bg-[var(--color-text-faint)] opacity-30" />
      </span>
    </span>
  )
}

export function NavigationPicker({
  value,
  onChange,
}: {
  value: RailPosition
  onChange: (position: RailPosition) => void
}) {
  const options: Array<{ position: RailPosition; title: string; description: string }> = [
    { position: 'left', title: 'Left rail', description: 'Vertical navigation at left.' },
    { position: 'bottom', title: 'Bottom dock', description: 'Horizontal dock at bottom.' },
    { position: 'top', title: 'Top dock', description: 'Floating dock with a notch at top.' },
  ]

  return (
    <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Desktop navigation position">
      {options.map((option) => {
        const selected = value === option.position
        return (
          <button
            key={option.position}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.position)}
            className={`min-h-11 rounded-xl border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-ink)] ${
              selected
                ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-text-faint)]'
            }`}
          >
            <LayoutThumbnail position={option.position} />
            <span className="mt-2 block px-1 text-sm font-semibold text-[var(--color-text)]">{option.title}</span>
            {/* TODO(ds): ChoiceCard is the DS radio-card, but it drops the px-1 label indent and the ring-offset here; left as-is to preserve exact look. */}
            <span className="block px-1 text-2xs text-[var(--color-text-faint)]">{option.description}</span>
          </button>
        )
      })}
    </div>
  )
}
