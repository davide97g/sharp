import { useStore } from '../store'
import {
  NO_WALLPAPER,
  randomMeshSeed,
  wallpaperStyle,
  type Wallpaper,
} from '../lib/wallpaper'
import { Button, ChoiceCard, SectionLabel } from '../ui'

// Per-conversation wallpaper, personal to the viewer — nobody else in the
// channel sees your choice, which is why it lives in `channel_prefs` rather
// than on the channel itself.
//
// Only procedural fills are offered: a theme-derived gradient mesh or a solid
// hue. Image uploads are deliberately absent — a wallpaper image would be a
// second source of never-collected orphan files (see docs/LEFTOVERS.md, which
// already tracks the missing GC for cancelled message uploads).

const PRESET_SEEDS = [137, 428, 913, 2044, 3771, 6180]

function Preview({ wallpaper }: { wallpaper: Wallpaper }) {
  const style = wallpaperStyle(wallpaper)
  return (
    <div className="relative h-16 w-full overflow-hidden rounded-lg bg-ink">
      {style && <div className="absolute inset-0" style={style} />}
      <div className="absolute inset-x-2 bottom-2 space-y-1">
        <div className="h-1.5 w-2/3 rounded bg-text-faint/50" />
        <div className="h-1.5 w-1/2 rounded bg-text-faint/30" />
      </div>
    </div>
  )
}

export function ChannelWallpaperPicker({ channelId }: { channelId: string }) {
  const current = useStore((s) => s.channelWallpapers[channelId]) ?? NO_WALLPAPER
  const setWallpaper = useStore((s) => s.setChannelWallpaper)
  const focusMode = useStore((s) => s.ui.focusMode)

  const dim = current.kind === 'none' ? 0.82 : current.dim
  const blur = current.kind === 'mesh' ? current.blur : 0

  const options: { key: string; label: string; value: Wallpaper }[] = [
    { key: 'none', label: 'None', value: NO_WALLPAPER },
    ...PRESET_SEEDS.map((seed) => ({
      key: `mesh-${seed}`,
      label: 'Mesh',
      value: { kind: 'mesh', seed, dim, blur } as Wallpaper,
    })),
  ]

  const isSelected = (value: Wallpaper) =>
    value.kind === current.kind &&
    (value.kind !== 'mesh' || (current.kind === 'mesh' && value.seed === current.seed))

  return (
    <div className="flex flex-col gap-3">
      <SectionLabel size="xs">Wallpaper</SectionLabel>
      <p className="text-2xs text-text-faint">
        Only you see this. Colours come from your active theme, so a wallpaper
        follows every preset you switch to.
      </p>
      {focusMode && (
        <p className="text-2xs text-warning-fg">
          Focus mode is on, so wallpapers are hidden right now.
        </p>
      )}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {options.map((o) => (
          <ChoiceCard
            key={o.key}
            selected={isSelected(o.value)}
            onSelect={() => void setWallpaper(channelId, o.value)}
            title={o.label}
            selectedStyle="ring"
          >
            <Preview wallpaper={o.value} />
          </ChoiceCard>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void setWallpaper(channelId, {
              kind: 'mesh',
              seed: randomMeshSeed(),
              dim,
              blur,
            })
          }
        >
          Shuffle
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={current.kind === 'none'}
          onClick={() => void setWallpaper(channelId, NO_WALLPAPER)}
        >
          Remove
        </Button>
      </div>

      {current.kind !== 'none' && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div>
            <SectionLabel as="label" size="xs" className="mb-2 block">
              Fade
            </SectionLabel>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(dim * 100)}
              aria-label="Wallpaper fade"
              onChange={(e) =>
                void setWallpaper(channelId, {
                  ...current,
                  dim: Number(e.target.value) / 100,
                })
              }
              className="range-slider w-full"
              style={{
                background: `linear-gradient(to right, var(--color-accent) ${dim * 100}%, var(--color-panel) ${dim * 100}%)`,
              }}
            />
          </div>
          {current.kind === 'mesh' && (
            <div>
              <SectionLabel as="label" size="xs" className="mb-2 block">
                Blur
              </SectionLabel>
              <input
                type="range"
                min={0}
                max={24}
                value={blur}
                aria-label="Wallpaper blur"
                onChange={(e) =>
                  void setWallpaper(channelId, { ...current, blur: Number(e.target.value) })
                }
                className="range-slider w-full"
                style={{
                  background: `linear-gradient(to right, var(--color-accent) ${(blur / 24) * 100}%, var(--color-panel) ${(blur / 24) * 100}%)`,
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
