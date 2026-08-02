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

import { normalizeIntensity, type SeasonalIntensity } from './seasonal'
import {
  KEYS,
  LEGACY_UI_KEYS,
  readLocal,
  readLocalJson,
  writeLocalJson,
} from './localPrefs'

export type ColorScheme = 'dark' | 'light' | 'system'
export type Density = 'cozy' | 'compact' | 'ultra'
export type RailPosition = 'left' | 'bottom' | 'top'
/** Message row shape. `irc` is the one-line `12:04 <name> text` form. */
export type MessageLayout = 'classic' | 'bubble' | 'irc'
export type AvatarShape = 'circle' | 'squircle' | 'square'
/** `hover` = clock time, revealed on hover for grouped rows (the original
 *  behaviour). The rest are always visible. */
export type TimestampStyle = 'hover' | 'clock24' | 'clock12' | 'relative'
export type SoundPack = 'default' | 'minimal' | 'retro' | 'nature' | 'mechanical'

/** Ambient surface treatments. All off by default — sharp ships plain. */
export type EffectFlags = {
  glass: boolean
  grain: boolean
  glow: boolean
  scanlines: boolean
}

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

  // --- chat style ---
  /** Default row shape in channels. DMs keep their own pick in
   *  `user_prefs.chat_layout` (the first-run chooser gates on it being null). */
  channelLayout: MessageLayout
  /** Per-channel override of the layout, keyed by channel id. */
  channelLayoutOverrides: Record<string, MessageLayout>
  avatarShape: AvatarShape
  /** Minutes within which consecutive messages from one author collapse.
   *  0 = never group. */
  groupWindowMin: number
  timestampStyle: TimestampStyle
  /** Tint author names with their deterministic user color (IRC-style). */
  nameColors: boolean
  /** Render unfurled link cards under messages. Off leaves the bare link. */
  linkPreviews: boolean

  // --- effects ---
  effects: EffectFlags
  /** Confetti/burst on ended polls and call joins. */
  celebrations: boolean
  soundPack: SoundPack
  /** Action id → chord, overriding the default in lib/shortcuts.ts. */
  shortcuts: Record<string, string>
  /** Minutes of inactivity before the screen locks. 0 = never. */
  idleLockMin: number
  /** Seasonal packs: `subtle` retints and re-words, `full` adds particles. */
  seasonal: SeasonalIntensity
  /** Master kill switch: no effects, no wallpapers, no celebrations, no
   *  seasonal. Also armed implicitly by the streaming privacy shield. */
  focusMode: boolean
}

export const UI_PREFS_KEY = KEYS.ui

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
  channelLayout: 'classic',
  channelLayoutOverrides: {},
  avatarShape: 'circle',
  groupWindowMin: 5,
  timestampStyle: 'hover',
  nameColors: false,
  linkPreviews: true,
  effects: { glass: false, grain: false, glow: false, scanlines: false },
  celebrations: true,
  soundPack: 'default',
  shortcuts: {},
  idleLockMin: 0,
  seasonal: 'subtle',
  focusMode: false,
}

export const DENSITIES: Density[] = ['cozy', 'compact', 'ultra']
export const FONT_SCALES = [0.9, 1, 1.1] as const
export const MESSAGE_LAYOUTS: MessageLayout[] = ['classic', 'bubble', 'irc']
export const AVATAR_SHAPES: AvatarShape[] = ['circle', 'squircle', 'square']
export const TIMESTAMP_STYLES: TimestampStyle[] = [
  'hover',
  'clock24',
  'clock12',
  'relative',
]
export const SOUND_PACKS: SoundPack[] = [
  'default',
  'minimal',
  'retro',
  'nature',
  'mechanical',
]
/** Cap on stored per-channel overrides — the whole blob is 8 KB server-side. */
const MAX_LAYOUT_OVERRIDES = 200

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
  const bool = (x: unknown, fallback: boolean) =>
    typeof x === 'boolean' ? x : fallback
  const oneOf = <T extends string>(x: unknown, allowed: T[], fallback: T): T =>
    allowed.includes(x as T) ? (x as T) : fallback
  const sounds = (v.sounds ?? {}) as Partial<UiPrefs['sounds']>
  const effects = (v.effects ?? {}) as Partial<EffectFlags>
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
    channelLayout: oneOf(v.channelLayout, MESSAGE_LAYOUTS, base.channelLayout),
    channelLayoutOverrides: normalizeOverrides(
      v.channelLayoutOverrides,
      base.channelLayoutOverrides,
    ),
    avatarShape: oneOf(v.avatarShape, AVATAR_SHAPES, base.avatarShape),
    groupWindowMin: num(v.groupWindowMin, base.groupWindowMin, 0, 1440),
    timestampStyle: oneOf(v.timestampStyle, TIMESTAMP_STYLES, base.timestampStyle),
    nameColors: bool(v.nameColors, base.nameColors),
    linkPreviews: bool(v.linkPreviews, base.linkPreviews),
    effects: {
      glass: bool(effects.glass, base.effects.glass),
      grain: bool(effects.grain, base.effects.grain),
      glow: bool(effects.glow, base.effects.glow),
      scanlines: bool(effects.scanlines, base.effects.scanlines),
    },
    celebrations: bool(v.celebrations, base.celebrations),
    soundPack: oneOf(v.soundPack, SOUND_PACKS, base.soundPack),
    shortcuts: normalizeShortcuts(v.shortcuts, base.shortcuts),
    idleLockMin: num(v.idleLockMin, base.idleLockMin, 0, 240),
    seasonal: normalizeIntensity(v.seasonal),
    focusMode: bool(v.focusMode, base.focusMode),
  }
}

/** Remaps are `id -> chord`; anything else in the blob is dropped. */
function normalizeShortcuts(
  raw: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const out: Record<string, string> = {}
  for (const [id, chord] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof chord === 'string' && chord.length > 0 && chord.length <= 24) {
      out[id] = chord
    }
  }
  return out
}

function normalizeOverrides(
  raw: unknown,
  fallback: Record<string, MessageLayout>,
): Record<string, MessageLayout> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fallback
  const out: Record<string, MessageLayout> = {}
  for (const [id, layout] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_LAYOUT_OVERRIDES) break
    if (MESSAGE_LAYOUTS.includes(layout as MessageLayout)) {
      out[id] = layout as MessageLayout
    }
  }
  return out
}

/** Read the local mirror. Also folds in the pre-0029 single-purpose keys, once. */
export function readLocalUiPrefs(): UiPrefs {
  if (typeof window === 'undefined') return { ...DEFAULT_UI_PREFS }
  // A corrupt or unavailable blob falls through to the legacy keys, then to defaults.
  const stored = readLocalJson<unknown>(UI_PREFS_KEY, null)
  if (stored) return normalizeUiPrefs(stored)
  return normalizeUiPrefs(readLegacyKeys())
}

/** Persist the mirror. Failure is non-fatal — the session keeps its in-memory value. */
export function writeLocalUiPrefs(prefs: UiPrefs) {
  writeLocalJson(UI_PREFS_KEY, prefs)
}

/**
 * The appearance prefs that used to live in their own localStorage keys. Read
 * once, when no `sharp.ui` blob exists yet, so upgrading users keep their theme
 * and rail position. The old keys are left in place — `sharp.sounds` is still
 * the sound engine's own mirror, and the rest are harmless.
 */
function readLegacyKeys(): Partial<UiPrefs> {
  const out: Partial<UiPrefs> = {}
  const get = readLocal
  // Pre-v2 values were 'dark' | 'light' | a preset id; the schemes collapse to
  // the default preset, matching the migration the old theme.ts did.
  const theme = get(LEGACY_UI_KEYS.theme)
  if (theme && theme !== 'dark' && theme !== 'light') out.theme = theme
  const rail = get(LEGACY_UI_KEYS.railPosition)
  if (rail === 'left' || rail === 'top' || rail === 'bottom') out.railPosition = rail
  const dock = get(LEGACY_UI_KEYS.dockAutoHide)
  if (dock !== null) out.dockAutoHide = dock === '1'
  const sounds = get(KEYS.sounds)
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
