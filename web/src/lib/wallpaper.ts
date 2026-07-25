// Per-conversation chat wallpaper.
//
// A wallpaper is a tiny descriptor, not an asset: a solid tone or a procedural
// gradient mesh generated from a seed. That keeps it inside a 2 KB jsonb column
// (migration 0030), makes it instant to render, and means it retints with the
// active theme instead of fighting it — a mesh is built from `color-mix()` over
// the live accent and surface tokens, so the same wallpaper looks right in
// every preset and in both schemes.
//
// Image uploads are deliberately not supported here; see the note in
// ChannelWallpaperPicker.

export type Wallpaper =
  | { kind: 'none' }
  | { kind: 'solid'; hue: number; dim: number }
  | { kind: 'mesh'; seed: number; dim: number; blur: number }

export const NO_WALLPAPER: Wallpaper = { kind: 'none' }

export function normalizeWallpaper(raw: unknown): Wallpaper {
  if (!raw || typeof raw !== 'object') return NO_WALLPAPER
  const v = raw as Record<string, unknown>
  const num = (x: unknown, fallback: number, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x)
      ? Math.min(hi, Math.max(lo, x))
      : fallback
  if (v.kind === 'solid') {
    return { kind: 'solid', hue: num(v.hue, 265, 0, 359), dim: num(v.dim, 0.9, 0, 1) }
  }
  if (v.kind === 'mesh') {
    return {
      kind: 'mesh',
      seed: num(v.seed, 1, 0, 9999),
      dim: num(v.dim, 0.82, 0, 1),
      blur: num(v.blur, 0, 0, 24),
    }
  }
  return NO_WALLPAPER
}

/**
 * The mesh palette. Built from theme tokens via `color-mix()` (not the newer
 * relative-colour `oklch(from …)` syntax, which several shipping browsers still
 * lack — and an unsupported colour invalidates the whole gradient), so a mesh
 * follows the active preset and both schemes for free.
 */
const MESH_TONES = [
  'var(--color-accent)',
  'color-mix(in oklab, var(--color-accent) 60%, var(--color-success))',
  'color-mix(in oklab, var(--color-accent) 55%, var(--color-warning))',
  'color-mix(in oklab, var(--color-accent) 50%, var(--color-danger))',
  'var(--color-accent-hover)',
]

/** Deterministic 0..1 stream from an integer seed (xorshift, no dependency). */
function rng(seed: number): () => number {
  let x = (seed | 0) || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return ((x >>> 0) % 10000) / 10000
  }
}

/**
 * CSS `background-image` for a wallpaper, or null when there is nothing to
 * paint. Mesh blobs are radial gradients placed by the seed; all colour comes
 * from theme tokens, so this never clashes with the active preset.
 */
export function wallpaperBackground(w: Wallpaper): string | null {
  if (w.kind === 'none') return null
  if (w.kind === 'solid') {
    return `linear-gradient(oklch(0.55 0.12 ${Math.round(w.hue)}), oklch(0.55 0.12 ${Math.round(w.hue)}))`
  }
  const rand = rng(w.seed)
  const layers: string[] = []
  for (let i = 0; i < MESH_TONES.length; i++) {
    const x = Math.round(rand() * 100)
    const y = Math.round(rand() * 100)
    const size = 35 + Math.round(rand() * 45)
    layers.push(
      `radial-gradient(${size}% ${size}% at ${x}% ${y}%, ${MESH_TONES[i]} 0%, transparent 70%)`,
    )
  }
  return layers.join(',')
}

/**
 * Inline style for the wallpaper layer. `dim` is applied as an opacity on the
 * layer itself rather than baked into the colours, so the message text above it
 * keeps the theme's own contrast.
 */
export function wallpaperStyle(w: Wallpaper): Record<string, string> | null {
  const background = wallpaperBackground(w)
  if (!background) return null
  const dim = w.kind === 'none' ? 1 : w.dim
  const blur = w.kind === 'mesh' ? w.blur : 0
  return {
    backgroundImage: background,
    opacity: String(1 - dim),
    ...(blur ? { filter: `blur(${blur}px)` } : {}),
  }
}

/** A fresh mesh, for the "shuffle" affordance in the picker. */
export function randomMeshSeed(): number {
  return 1 + Math.floor(Math.random() * 9999)
}
