import { THEME_PRESETS, type ThemePreset } from '../lib/theme'

function ThemeCard({
  preset,
  title,
  desc,
  swatches,
  selected,
  onSelect,
}: {
  preset: ThemePreset
  title: string
  desc: string
  swatches: [string, string, string]
  selected: boolean
  onSelect: () => void
}) {
  const [ink, accent, text] = swatches
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-2 text-left transition ${
        selected
          ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-text-faint)]'
      }`}
    >
      <div
        className="flex flex-col gap-1.5 rounded-lg p-3"
        style={{ backgroundColor: ink }}
        data-theme-preview={preset}
      >
        <div className="h-2.5 w-1/2 rounded" style={{ backgroundColor: accent }} />
        <div
          className="rounded px-2 py-1.5"
          style={{
            backgroundColor: colorMix(ink, 18),
            border: `1px solid ${colorMix(text, 18)}`,
            width: '90%',
          }}
        >
          <div className="h-1.5 w-3/4 rounded" style={{ backgroundColor: text, opacity: 0.55 }} />
        </div>
        <div
          className="rounded px-2 py-1.5"
          style={{
            backgroundColor: colorMix(ink, 18),
            border: `1px solid ${colorMix(text, 18)}`,
            width: '70%',
          }}
        >
          <div className="h-1.5 w-2/3 rounded" style={{ backgroundColor: text, opacity: 0.35 }} />
        </div>
      </div>
      <div className="mt-2 px-1">
        <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-[11px] text-[var(--color-text-faint)]">{desc}</div>
      </div>
    </button>
  )
}

/** Cheap hex → rgba for preview chrome without needing the live CSS vars. */
function colorMix(hex: string, alphaPct: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgb(${r} ${g} ${b} / ${alphaPct}%)`
}

/** Shared 4-preset picker used by the auth-stage setup + settings Appearance. */
export function ThemePicker({
  value,
  onChange,
}: {
  value: ThemePreset
  onChange: (preset: ThemePreset) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {THEME_PRESETS.map((p) => (
        <ThemeCard
          key={p.id}
          preset={p.id}
          title={p.title}
          desc={p.desc}
          swatches={p.swatches}
          selected={value === p.id}
          onSelect={() => onChange(p.id)}
        />
      ))}
    </div>
  )
}
