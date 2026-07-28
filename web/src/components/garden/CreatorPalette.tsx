import { Button, Kbd } from '../../ui'
import { GARDEN_PROPS, propSheetKey } from './gardenProps'

const SHEET_URL: Record<string, string> = {
  'garden-nature': '/assets/garden/ninja-adventure/tileset_nature.png',
  'garden-village': '/assets/garden/ninja-adventure/tileset_village.png',
}

/** Thumbnail of a catalogue crop, using the same CSS-crop trick as RoomPreview. */
function PropThumb({ id }: { id: string }) {
  const def = GARDEN_PROPS.find((prop) => prop.id === id)
  if (!def) return null
  // Fit the crop into a 40px box without upscaling past 2x, so a 96px tree and a
  // 11px tuft both stay recognisable.
  const scale = Math.min(2, 36 / Math.max(def.crop.width, def.crop.height))
  return (
    <span
      className="relative block h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border bg-[#8fae3d]"
      aria-hidden
    >
      <img
        src={SHEET_URL[propSheetKey(def.sheet)]}
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-w-none select-none"
        style={{
          imageRendering: 'pixelated',
          transformOrigin: 'top left',
          transform: `scale(${scale})`,
          left: `${20 - (def.crop.x + def.crop.width / 2) * scale}px`,
          top: `${20 - (def.crop.y + def.crop.height / 2) * scale}px`,
        }}
      />
    </span>
  )
}

type Props = {
  brush: string | null
  onBrush: (id: string | null) => void
  selection: string | null
  onDelete: () => void
  onExit: () => void
  count: number
}

/**
 * Creator-mode palette. Replaces the room rail while editing, since both want the
 * same corner and only one is useful at a time.
 */
export function CreatorPalette({
  brush,
  onBrush,
  selection,
  onDelete,
  onExit,
  count,
}: Props) {
  return (
    <aside className="absolute bottom-4 left-3 top-[4.6rem] z-(--z-dropdown) hidden w-72 flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]/96 shadow-2xl backdrop-blur sm:left-4 lg:flex">
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--color-text)]">Creator mode</h2>
          <span className="text-2xs text-[var(--color-text-faint)]">{count} placed</span>
        </div>
        <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">
          {brush
            ? 'Click the map to place. Pick again to change.'
            : 'Choose scenery, or drag what is already there.'}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-3 gap-1.5">
          {GARDEN_PROPS.map((prop) => {
            const active = brush === prop.id
            return (
              <button
                key={prop.id}
                type="button"
                aria-pressed={active}
                title={prop.label}
                onClick={() => onBrush(active ? null : prop.id)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-colors motion-reduce:transition-none ${
                  active
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                    : 'border-transparent hover:border-[var(--color-border)]'
                }`}
              >
                <PropThumb id={prop.id} />
                <span className="w-full truncate text-center text-[10px] text-[var(--color-text-dim)]">
                  {prop.label}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-[var(--color-border)] p-2">
        <Button
          variant="ghost"
          className="w-full justify-center"
          disabled={!selection}
          onClick={onDelete}
        >
          Delete selected
          <Kbd>Del</Kbd>
        </Button>
        <Button variant="ghost" className="w-full justify-center" onClick={onExit}>
          Done editing
          <Kbd>Esc</Kbd>
        </Button>
      </div>
    </aside>
  )
}
