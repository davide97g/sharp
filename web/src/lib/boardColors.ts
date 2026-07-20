// Categorical palette for board select/multi-select options. Colors are stored
// as palette *keys* (e.g. "blue"), never hex — the actual values are CSS custom
// properties (--board-<key>-bg / -fg) defined in index.css, tuned for the dark
// UI. Components read BOARD_COLORS[key] and drop bg/fg straight into style.

export type PaletteKey =
  | 'gray'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'purple'
  | 'pink'

export const PALETTE_KEYS: PaletteKey[] = [
  'gray',
  'blue',
  'green',
  'yellow',
  'orange',
  'red',
  'purple',
  'pink',
]

type Swatch = { bg: string; fg: string; label: string }

export const BOARD_COLORS: Record<PaletteKey, Swatch> = {
  gray: { bg: 'var(--board-gray-bg)', fg: 'var(--board-gray-fg)', label: 'Gray' },
  blue: { bg: 'var(--board-blue-bg)', fg: 'var(--board-blue-fg)', label: 'Blue' },
  green: { bg: 'var(--board-green-bg)', fg: 'var(--board-green-fg)', label: 'Green' },
  yellow: { bg: 'var(--board-yellow-bg)', fg: 'var(--board-yellow-fg)', label: 'Yellow' },
  orange: { bg: 'var(--board-orange-bg)', fg: 'var(--board-orange-fg)', label: 'Orange' },
  red: { bg: 'var(--board-red-bg)', fg: 'var(--board-red-fg)', label: 'Red' },
  purple: { bg: 'var(--board-purple-bg)', fg: 'var(--board-purple-fg)', label: 'Purple' },
  pink: { bg: 'var(--board-pink-bg)', fg: 'var(--board-pink-fg)', label: 'Pink' },
}

// Rotate through the palette when auto-assigning a color to a new option.
export function nextColor(index: number): PaletteKey {
  return PALETTE_KEYS[((index % PALETTE_KEYS.length) + PALETTE_KEYS.length) % PALETTE_KEYS.length]
}

// Resolve a stored color key to its swatch, falling back to gray for unknown keys.
export function colorOf(key: string): Swatch {
  return BOARD_COLORS[key as PaletteKey] ?? BOARD_COLORS.gray
}
