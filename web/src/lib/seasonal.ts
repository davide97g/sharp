// Seasonal event packs.
//
// A pack is data, not code: a date window plus an accent retint, a particle
// effect, a reaction set, and a line of copy. Adding Diwali or a company
// anniversary is an entry in `EVENT_PACKS`, nothing more.
//
// Three levels of governance, all of which can say no:
//   1. the workspace may disable packs for everyone,
//   2. the user picks `off` / `subtle` / `full`,
//   3. Focus mode and `prefers-reduced-motion` force it off regardless.
// `subtle` is the default: colour and copy change, particles do not. A work
// tool should not start snowing on someone who never asked for snow.
//
// The **preview override** (`setPackPreview`) pins one pack regardless of the
// date, so a pack can be seen — and reviewed — without waiting for October. It
// is device-local (localStorage, never the synced blob) and beats the calendar
// but nothing above it: intensity, Focus mode and reduced-motion still win.

import { KEYS, readLocal, removeLocal, writeLocal } from './localPrefs'

export type SeasonalIntensity = 'off' | 'subtle' | 'full'

export type EventEffect = 'snow' | 'confetti' | 'leaves' | 'sparks' | 'petals'

export type EventPack = {
  id: string
  name: string
  /** Inclusive window as [month, day] pairs in the user's local calendar. */
  from: [number, number]
  to: [number, number]
  /** Hue that replaces the accent while the pack is active. */
  accentHue: number
  /** Particles — only rendered at `full` intensity. */
  effect: EventEffect | null
  /** Offered first in the reaction picker while active. */
  reactions: string[]
  /** Mascot skin id, consumed by the duck components. */
  mascot: string | null
  /** Shown on the empty home surface. */
  greeting: string
}

export const EVENT_PACKS: EventPack[] = [
  {
    id: 'halloween',
    name: 'Halloween',
    from: [10, 24],
    to: [11, 1],
    accentHue: 40,
    effect: 'sparks',
    reactions: ['🎃', '👻', '🦇', '🕸️', '💀'],
    mascot: 'witch-hat',
    greeting: 'Something wicked this way ships.',
  },
  {
    id: 'winter',
    name: 'Winter holidays',
    from: [12, 10],
    to: [12, 27],
    accentHue: 145,
    effect: 'snow',
    reactions: ['🎄', '🎁', '⛄', '🔔', '🕯️'],
    mascot: 'santa-hat',
    greeting: 'Wrapping up for the year.',
  },
  {
    id: 'new-year',
    name: 'New Year',
    from: [12, 31],
    to: [1, 2],
    accentHue: 85,
    effect: 'confetti',
    reactions: ['🎉', '🥂', '✨', '🎆'],
    mascot: 'party-hat',
    greeting: 'New year, same duck.',
  },
  {
    id: 'lunar-new-year',
    name: 'Lunar New Year',
    from: [1, 28],
    to: [2, 5],
    accentHue: 25,
    effect: 'petals',
    reactions: ['🧧', '🏮', '🐉', '🎆'],
    mascot: 'lantern',
    greeting: 'Fortune favours the shipped.',
  },
  {
    id: 'spring',
    name: 'Spring',
    from: [3, 20],
    to: [3, 27],
    accentHue: 330,
    effect: 'petals',
    reactions: ['🌸', '🌱', '🐣', '🌷'],
    mascot: null,
    greeting: 'Fresh start, fresh backlog.',
  },
  {
    id: 'pride',
    name: 'Pride',
    from: [6, 1],
    to: [6, 30],
    accentHue: 300,
    effect: null,
    reactions: ['🏳️‍🌈', '❤️', '🧡', '💛', '💚', '💙', '💜'],
    mascot: 'rainbow',
    greeting: 'Everyone belongs here.',
  },
  {
    id: 'autumn',
    name: 'Autumn',
    from: [9, 22],
    to: [9, 29],
    accentHue: 55,
    effect: 'leaves',
    reactions: ['🍂', '🍁', '🌰', '☕'],
    mascot: null,
    greeting: 'Sweater weather, shipping weather.',
  },
]

export function packById(id: string | null | undefined): EventPack | null {
  return EVENT_PACKS.find((p) => p.id === id) ?? null
}

/** The pinned pack id, or null when the calendar decides. */
export function packPreview(): string | null {
  if (typeof window === 'undefined') return null
  return packById(readLocal(KEYS.seasonPreview))?.id ?? null
}

/**
 * Pin a pack (or `null` to hand control back to the calendar). Persisted so a
 * reload keeps the preview — the point is to walk the whole app in-season.
 * Callers must re-apply appearance afterwards; the store action does.
 */
export function setPackPreview(id: string | null) {
  if (id && packById(id)) writeLocal(KEYS.seasonPreview, id)
  else removeLocal(KEYS.seasonPreview)
}

/**
 * The pack in force for a given local date, if any.
 *
 * Windows are compared as month/day so they repeat every year, and a window may
 * wrap the year boundary (New Year runs 31 Dec – 2 Jan). A preview override
 * short-circuits the whole comparison.
 */
export function activePack(
  now: Date = new Date(),
  preview: string | null = packPreview(),
): EventPack | null {
  if (preview) return packById(preview)
  const md = (now.getMonth() + 1) * 100 + now.getDate()
  for (const pack of EVENT_PACKS) {
    const from = pack.from[0] * 100 + pack.from[1]
    const to = pack.to[0] * 100 + pack.to[1]
    const inWindow = from <= to ? md >= from && md <= to : md >= from || md <= to
    if (inWindow) return pack
  }
  return null
}

export function normalizeIntensity(raw: unknown): SeasonalIntensity {
  return raw === 'off' || raw === 'full' ? raw : 'subtle'
}
