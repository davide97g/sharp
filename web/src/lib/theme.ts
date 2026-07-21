// Client-only appearance presets. Applied via `data-theme` on <html> so
// index.css token overrides take effect. Persisted in localStorage under the
// same key that used to store dark/light (migrated below).

export type ThemePreset = 'default' | 'slack' | 'teams' | 'one-piece'

const THEME_KEY = 'sharp.theme'

const PRESETS: ThemePreset[] = ['default', 'slack', 'teams', 'one-piece']

export function isThemePreset(value: string): value is ThemePreset {
  return (PRESETS as string[]).includes(value)
}

/** Migrate legacy dark/light values; unknown → default. */
export function getThemePreset(): ThemePreset {
  try {
    const raw = window.localStorage.getItem(THEME_KEY)
    if (!raw) return 'default'
    if (raw === 'dark' || raw === 'light') return 'default'
    if (isThemePreset(raw)) return raw
    return 'default'
  } catch {
    return 'default'
  }
}

export function setThemePreset(preset: ThemePreset) {
  try {
    window.localStorage.setItem(THEME_KEY, preset)
  } catch {
    /* ignore */
  }
  applyTheme(preset)
}

export function applyTheme(preset: ThemePreset = getThemePreset()) {
  const root = document.documentElement
  if (preset === 'default') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', preset)
  }
}

export const THEME_PRESETS: {
  id: ThemePreset
  title: string
  desc: string
  swatches: [string, string, string]
}[] = [
  {
    id: 'default',
    title: 'Default',
    desc: 'Sharp’s purple accent on deep ink.',
    swatches: ['#0e0e11', '#7c6cff', '#e6e6ea'],
  },
  {
    id: 'slack',
    title: 'Slack',
    desc: 'Aubergine chrome with a green accent.',
    swatches: ['#1a0f1c', '#2eb67d', '#e8e0ea'],
  },
  {
    id: 'teams',
    title: 'Teams',
    desc: 'Cool panels with Teams purple-blue.',
    swatches: ['#0f111a', '#5b5fc7', '#e2e4f0'],
  },
  {
    id: 'one-piece',
    title: 'One Piece',
    desc: 'Ocean navy with straw-hat gold & red.',
    swatches: ['#0a1628', '#f0c14b', '#e8d5c4'],
  },
]
