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

/**
 * The pack in force for a given local date, if any.
 *
 * Windows are compared as month/day so they repeat every year, and a window may
 * wrap the year boundary (New Year runs 31 Dec – 2 Jan).
 */
export function activePack(now: Date = new Date()): EventPack | null {
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
