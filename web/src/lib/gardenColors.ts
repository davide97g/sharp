// Highlight colours for Garden peers.
//
// The server assigns a slot by join order and sends only the index
// (`GardenPeer.color_index`); the colours themselves live here, so the palette is
// one list in one language. Slot 0 is purple — the product accent — so the first
// person in the hub looks "default".
//
// These are hex rather than `boardColors.ts` palette keys because Phaser needs a
// 24-bit number and `BOARD_COLORS` resolves to `var(--board-*)` CSS references,
// which a WebGL fill cannot consume. They are also world colours rather than
// chrome: they must stay legible against grass and stone no matter which theme
// preset or accent hue the viewer picked, so unlike every other colour in the app
// they deliberately do not follow the theme.
//
// Order interleaves the wheel instead of walking it, because ten hues at one
// lightness are hard to tell apart on a 28x17 ring at zoom 1 — adjacency is what
// makes two peers look identical.

export type GardenColor = {
  /** Ring fill and stroke, and the label's left accent tick. */
  hex: string
  /** Human name, so colour is never the only channel (a11y). */
  label: string
}

export const GARDEN_COLORS: GardenColor[] = [
  { hex: '#8b7cff', label: 'Purple' },
  { hex: '#e0913a', label: 'Amber' },
  { hex: '#5c9bff', label: 'Blue' },
  { hex: '#4fbf9f', label: 'Green' },
  { hex: '#e05a7d', label: 'Pink' },
  { hex: '#d8c53f', label: 'Yellow' },
  { hex: '#e0563f', label: 'Red' },
  { hex: '#3fc4c9', label: 'Teal' },
  { hex: '#b06cff', label: 'Violet' },
  { hex: '#9aa7b2', label: 'Slate' },
]

/** Slot count. Mirrors `GARDEN_COLOR_COUNT` in `server/src/ws/garden.rs`. */
export const GARDEN_COLOR_COUNT = GARDEN_COLORS.length

/**
 * Colour for a slot. Wraps and tolerates a missing or out-of-range index, so a
 * client talking to a server that predates colour assignment still renders.
 */
export function gardenColor(index: number | undefined | null): GardenColor {
  if (typeof index !== 'number' || !Number.isFinite(index)) return GARDEN_COLORS[0]
  const slot = ((Math.trunc(index) % GARDEN_COLOR_COUNT) + GARDEN_COLOR_COUNT) %
    GARDEN_COLOR_COUNT
  return GARDEN_COLORS[slot]
}

/** Same colour as a Phaser-ready 24-bit number. */
export function gardenColorValue(index: number | undefined | null): number {
  return Number.parseInt(gardenColor(index).hex.slice(1), 16)
}
