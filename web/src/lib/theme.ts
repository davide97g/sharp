// Appearance engine.
//
// Split by cost: **palettes are static CSS** (`themes.css`, one
// `:root[data-theme='<id>']` block each) so a reload paints the right colors
// with zero JavaScript, while the small continuous knobs — accent hue, density,
// interface scale, motion — are injected at runtime into a single <style> tag.
//
// This file owns only metadata and the apply logic; it holds no hex. The
// inline boot script in index.html mirrors `applyUiPrefs` closely enough to
// avoid a flash of the wrong theme — keep the two in sync.

import { activePack } from './seasonal'
import {
  DEFAULT_UI_PREFS,
  readLocalUiPrefs,
  type ColorScheme,
  type Density,
  type UiPrefs,
} from './uiPrefs'

export type Theme = {
  id: string
  title: string
  desc: string
  scheme: 'dark' | 'light'
  /** Sibling in the opposite scheme, used when the user picks "System". */
  pairWith?: string
  /** [ink, accent, text] — preview only; the real values live in themes.css. */
  swatches: [string, string, string]
}

export const THEMES: Theme[] = [
  {
    id: 'default',
    title: 'Default',
    desc: 'Sharp’s purple accent on deep ink.',
    scheme: 'dark',
    pairWith: 'daylight',
    swatches: ['#0e0e11', '#7c6cff', '#e6e6ea'],
  },
  {
    id: 'daylight',
    title: 'Daylight',
    desc: 'Sharp’s purple on clean white.',
    scheme: 'light',
    pairWith: 'default',
    swatches: ['#f7f7f9', '#6a5af0', '#1b1b21'],
  },
  {
    id: 'nord',
    title: 'Nord',
    desc: 'Arctic blue-grey with a frost accent.',
    scheme: 'dark',
    swatches: ['#2e3440', '#88c0d0', '#eceff4'],
  },
  {
    id: 'dracula',
    title: 'Dracula',
    desc: 'Classic dark violet on charcoal.',
    scheme: 'dark',
    swatches: ['#21222c', '#bd93f9', '#f8f8f2'],
  },
  {
    id: 'catppuccin-mocha',
    title: 'Catppuccin Mocha',
    desc: 'Soft pastel mauve on warm dark.',
    scheme: 'dark',
    pairWith: 'catppuccin-latte',
    swatches: ['#11111b', '#cba6f7', '#cdd6f4'],
  },
  {
    id: 'catppuccin-latte',
    title: 'Catppuccin Latte',
    desc: 'The pastel palette, daylight edition.',
    scheme: 'light',
    pairWith: 'catppuccin-mocha',
    swatches: ['#e6e9ef', '#8839ef', '#4c4f69'],
  },
  {
    id: 'tokyo-night',
    title: 'Tokyo Night',
    desc: 'Deep indigo with a neon blue accent.',
    scheme: 'dark',
    swatches: ['#16161e', '#7aa2f7', '#c0caf5'],
  },
  {
    id: 'gruvbox',
    title: 'Gruvbox',
    desc: 'Retro warm browns and mustard.',
    scheme: 'dark',
    swatches: ['#1d2021', '#fabd2f', '#ebdbb2'],
  },
  {
    id: 'solarized-light',
    title: 'Solarized Light',
    desc: 'Low-contrast cream with cyan blue.',
    scheme: 'light',
    swatches: ['#eee8d5', '#268bd2', '#073642'],
  },
  {
    id: 'paper',
    title: 'Paper',
    desc: 'E-ink calm — near-black ink on warm white.',
    scheme: 'light',
    swatches: ['#f4f2ed', '#3a3a38', '#1a1a18'],
  },
  {
    id: 'high-contrast',
    title: 'High Contrast',
    desc: 'Maximum legibility: pure black, amber accent.',
    scheme: 'dark',
    swatches: ['#000000', '#ffd400', '#ffffff'],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    desc: 'Monospaced phosphor green on black.',
    scheme: 'dark',
    swatches: ['#000000', '#33ff66', '#c8ffd4'],
  },
  {
    id: 'slack',
    title: 'Slack',
    desc: 'Aubergine chrome with a green accent.',
    scheme: 'dark',
    swatches: ['#1a0f1c', '#2eb67d', '#e8e0ea'],
  },
  {
    id: 'teams',
    title: 'Teams',
    desc: 'Cool panels with Teams purple-blue.',
    scheme: 'dark',
    swatches: ['#0f111a', '#5b5fc7', '#e2e4f0'],
  },
  {
    id: 'one-piece',
    title: 'One Piece',
    desc: 'Ocean navy with straw-hat gold & red.',
    scheme: 'dark',
    swatches: ['#0a1628', '#e85d4c', '#e8d5c4'],
  },
]

export const DARK_THEMES = THEMES.filter((t) => t.scheme === 'dark')
export const LIGHT_THEMES = THEMES.filter((t) => t.scheme === 'light')

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id)
}

export function isThemeId(value: string): boolean {
  return THEMES.some((t) => t.id === value)
}

/** What the OS is asking for. Defaults to dark when the query is unavailable. */
export function systemScheme(): 'dark' | 'light' {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function resolveScheme(scheme: ColorScheme): 'dark' | 'light' {
  return scheme === 'system' ? systemScheme() : scheme
}

/** The preset that should actually be on screen for these prefs right now. */
export function resolveTheme(prefs: UiPrefs): Theme {
  const scheme = resolveScheme(prefs.scheme)
  const wanted = scheme === 'light' ? prefs.themeLight : prefs.theme
  const theme = themeById(wanted)
  // A preset from a removed/renamed set, or one saved before the scheme flipped:
  // fall back to that scheme's sibling, then to its default.
  if (theme && theme.scheme === scheme) return theme
  const paired = theme?.pairWith ? themeById(theme.pairWith) : undefined
  if (paired && paired.scheme === scheme) return paired
  return themeById(scheme === 'light' ? DEFAULT_UI_PREFS.themeLight : DEFAULT_UI_PREFS.theme)!
}

// --- runtime knobs -----------------------------------------------------------

/** Avatar edge in px per density. Exported because some call sites size the
 *  avatar in JS (`<Avatar size={n}>`) rather than in CSS. */
export const AVATAR_PX: Record<Density, number> = { cozy: 36, compact: 28, ultra: 22 }

const DENSITY_VARS: Record<Density, Record<string, string>> = {
  cozy: {
    // Leading padding on a message that starts a group…
    '--density-msg-y': '0.5rem',
    // …and on one collapsed into the group above it.
    '--density-row-y': '0.125rem',
    '--density-gap': '0.5rem',
    '--density-avatar': '36px',
  },
  compact: {
    '--density-msg-y': '0.3125rem',
    '--density-row-y': '0.0625rem',
    '--density-gap': '0.375rem',
    '--density-avatar': '28px',
  },
  ultra: {
    '--density-msg-y': '0.125rem',
    '--density-row-y': '0px',
    '--density-gap': '0.25rem',
    '--density-avatar': '22px',
  },
}

/**
 * Accent ramp from a single hue, in OKLCH so lightness stays perceptually even
 * across hues (a yellow and a blue at the same L actually look equally bright).
 * Lightness/chroma are fixed per scheme, which is what keeps a user-chosen hue
 * from landing on an unreadable accent.
 */
function accentVars(hue: number, scheme: 'dark' | 'light'): Record<string, string> {
  const h = Math.round(hue)
  return scheme === 'light'
    ? {
        '--color-accent': `oklch(0.55 0.17 ${h})`,
        '--color-accent-hover': `oklch(0.49 0.17 ${h})`,
        '--color-accent-soft': `oklch(0.93 0.05 ${h})`,
      }
    : {
        '--color-accent': `oklch(0.68 0.16 ${h})`,
        '--color-accent-hover': `oklch(0.74 0.16 ${h})`,
        '--color-accent-soft': `oklch(0.32 0.08 ${h})`,
      }
}

/**
 * Every property the runtime block can set. Listed explicitly so switching a
 * knob back to "inherit the preset" (accent hue → null) actually removes the
 * override instead of leaving a stale one behind.
 */
const RUNTIME_VARS = [
  '--font-scale',
  '--motion-scale',
  '--density-msg-y',
  '--density-row-y',
  '--density-gap',
  '--density-avatar',
  '--color-accent',
  '--color-accent-hover',
  '--color-accent-soft',
]

/**
 * Push a full set of preferences onto the document: preset attribute, scheme
 * hint, and the runtime overrides. Safe to call repeatedly.
 *
 * The overrides go on the element's inline style rather than into a <style>
 * block on purpose. A `:root{}` rule only wins on source order, and Vite
 * injects the app stylesheet at runtime in dev — so a style tag appended at
 * boot silently loses to `index.css`. Inline properties always win.
 */
export function applyUiPrefs(prefs: UiPrefs = readLocalUiPrefs(), focusOverride = false) {
  const root = document.documentElement
  const theme = resolveTheme(prefs)
  // Focus mode is the master kill switch for anything decorative. `focusOverride`
  // is how the streaming privacy shield borrows it without touching the stored
  // preference.
  const focus = prefs.focusMode || focusOverride
  const fx = focus
    ? []
    : (Object.keys(prefs.effects) as (keyof typeof prefs.effects)[]).filter(
        (k) => prefs.effects[k],
      )
  if (fx.length) root.setAttribute('data-fx', fx.join(' '))
  else root.removeAttribute('data-fx')
  root.toggleAttribute('data-focus', focus)
  // `default` is the bare @theme palette, so it carries no attribute.
  if (theme.id === 'default') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme.id)
  root.setAttribute('data-scheme', theme.scheme)
  root.style.colorScheme = theme.scheme

  // Seasonal packs retint the accent while they are in window — but never over
  // an accent the user chose explicitly, and never in Focus mode.
  const pack = focus || prefs.seasonal === 'off' ? null : activePack()
  const hue = prefs.accentHue ?? pack?.accentHue ?? null
  const vars: Record<string, string> = {
    ...DENSITY_VARS[prefs.density],
    '--font-scale': String(prefs.fontScale),
    '--motion-scale': String(prefs.motion),
    ...(hue === null ? {} : accentVars(hue, theme.scheme)),
  }
  if (pack) root.setAttribute('data-season', pack.id)
  else root.removeAttribute('data-season')
  for (const name of RUNTIME_VARS) {
    const value = vars[name]
    if (value === undefined) root.style.removeProperty(name)
    else root.style.setProperty(name, value)
  }
}

/**
 * Re-apply on OS appearance changes. Only matters while `scheme` is 'system',
 * but the listener is cheap and always live so the callback stays stateless.
 */
export function watchSystemScheme(onChange: () => void): () => void {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  } catch {
    return () => {}
  }
}
