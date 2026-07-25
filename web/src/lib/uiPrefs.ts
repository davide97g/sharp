// The single home for every appearance preference.
//
// Two-tier persistence, on purpose:
//   - localStorage `sharp.ui` is a *mirror*, read by the inline boot script in
//     index.html so the first paint is already themed (no flash) and so the app
//     looks right before the network answers.
//   - `user_prefs.ui` (jsonb, migration 0029) is the *truth*. It arrives with
//     `loadInboxAndPrefs()` and overwrites the mirror wholesale — no merging, no
//     clock comparison. Changes fan out to the user's other devices live via the
//     `prefs.updated` WS event.
//
// The server never interprets this blob; the shape lives here and here only, so
// adding a preference costs nothing on the backend. PATCH /prefs/ui merges at the
// top level only, so a nested value (`sounds`) must always be sent complete.

export type ColorScheme = 'dark' | 'light' | 'system'
export type Density = 'cozy' | 'compact' | 'ultra'
export type RailPosition = 'left' | 'bottom' | 'top'

export type UiPrefs = {
  /** Preset id used when the resolved scheme is dark. */
  theme: string
  /** Preset id used when the resolved scheme is light. */
  themeLight: string
  scheme: ColorScheme
  /** 0–359 hue override for the accent ramp; null = keep the preset's accent. */
  accentHue: number | null
  density: Density
  /** UI text size multiplier. */
  fontScale: number
  /** Animation duration multiplier; 0 = still. `prefers-reduced-motion` still wins. */
  motion: number
  railPosition: RailPosition
  dockAutoHide: boolean
  sounds: { enabled: boolean; volume: number }
}

export const UI_PREFS_KEY = 'sharp.ui'

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: 'default',
  themeLight: 'daylight',
  scheme: 'dark',
  accentHue: null,
  density: 'cozy',
  fontScale: 1,
  motion: 1,
  railPosition: 'left',
  dockAutoHide: false,
  sounds: { enabled: true, volume: 0.7 },
}

export const DENSITIES: Density[] = ['cozy', 'compact', 'ultra']
export const FONT_SCALES = [0.9, 1, 1.1] as const

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * Coerce anything (stored JSON, a server blob, a partial patch) into a valid
 * UiPrefs, falling back per-field. Never throws — a corrupt blob degrades to
 * defaults rather than a blank app.
 */
export function normalizeUiPrefs(
  raw: unknown,
  base: UiPrefs = DEFAULT_UI_PREFS,
): UiPrefs {
  const v = (raw ?? {}) as Partial<UiPrefs>
  const str = (x: unknown, fallback: string) =>
    typeof x === 'string' && x ? x : fallback
  const num = (x: unknown, fallback: number, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : fallback
  const sounds = (v.sounds ?? {}) as Partial<UiPrefs['sounds']>
  return {
    theme: str(v.theme, base.theme),
    themeLight: str(v.themeLight, base.themeLight),
    scheme:
      v.scheme === 'dark' || v.scheme === 'light' || v.scheme === 'system'
        ? v.scheme
        : base.scheme,
    accentHue:
      v.accentHue === null
        ? null
        : typeof v.accentHue === 'number' && Number.isFinite(v.accentHue)
          ? ((v.accentHue % 360) + 360) % 360
          : base.accentHue,
    density: DENSITIES.includes(v.density as Density)
      ? (v.density as Density)
      : base.density,
    fontScale: num(v.fontScale, base.fontScale, 0.8, 1.3),
    motion: num(v.motion, base.motion, 0, 1.5),
    railPosition:
      v.railPosition === 'left' || v.railPosition === 'top' || v.railPosition === 'bottom'
        ? v.railPosition
        : base.railPosition,
    dockAutoHide:
      typeof v.dockAutoHide === 'boolean' ? v.dockAutoHide : base.dockAutoHide,
    sounds: {
      enabled:
        typeof sounds.enabled === 'boolean' ? sounds.enabled : base.sounds.enabled,
      volume: num(sounds.volume, base.sounds.volume, 0, 1),
    },
  }
}

/** Read the local mirror. Also folds in the pre-0029 single-purpose keys, once. */
export function readLocalUiPrefs(): UiPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_UI_PREFS }
  let stored: unknown = null
  try {
    const raw = window.localStorage.getItem(UI_PREFS_KEY)
    if (raw) stored = JSON.parse(raw)
  } catch {
    /* corrupt or unavailable — fall through to legacy/defaults */
  }
  if (stored) return normalizeUiPrefs(stored)
  return normalizeUiPrefs(readLegacyKeys())
}

/** Persist the mirror. Failure is non-fatal — the session keeps its in-memory value. */
export function writeLocalUiPrefs(prefs: UiPrefs) {
  try {
    window.localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable (private mode, quota) */
  }
}

/**
 * The appearance prefs that used to live in their own localStorage keys. Read
 * once, when no `sharp.ui` blob exists yet, so upgrading users keep their theme
 * and rail position. The old keys are left in place — `sharp.sounds` is still
 * the sound engine's own mirror, and the rest are harmless.
 */
function readLegacyKeys(): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {}
  const get = (key: string) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  }
  // Pre-v2 values were 'dark' | 'light' | a preset id; the schemes collapse to
  // the default preset, matching the migration the old theme.ts did.
  const theme = get('sharp.theme')
  if (theme && theme !== 'dark' && theme !== 'light') out.theme = theme
  const rail = get('sharp.railPosition')
  if (rail === 'left' || rail === 'top' || rail === 'bottom') out.railPosition = rail
  const dock = get('sharp.dockAutoHide')
  if (dock !== null) out.dockAutoHide = dock === '1'
  const sounds = get('sharp.sounds')
  if (sounds) {
    try {
      const parsed = JSON.parse(sounds) as Partial<UiPrefs['sounds']>
      out.sounds = {
        enabled: parsed.enabled ?? DEFAULT_UI_PREFS.sounds.enabled,
        volume: parsed.volume ?? DEFAULT_UI_PREFS.sounds.volume,
      }
    } catch {
      /* ignore */
    }
  }
  return out
}
