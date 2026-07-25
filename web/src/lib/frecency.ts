// Frecency ranking for the command palette.
//
// With an empty query the palette used to show `items.slice(0, 20)` in whatever
// order the store happened to hold — so the first thing you saw was rarely the
// thing you wanted. This tracks what you actually open and ranks by a blend of
// frequency and recency ("frecency", the Firefox awesomebar heuristic).
//
// Deliberately localStorage, not the synced `ui` blob: this is high-churn data
// (every single navigation writes), it is worthless on another device, and the
// blob has an 8 KB server-side ceiling.

const KEY = 'sharp.frecency'
const MAX_ENTRIES = 300

type Entry = { n: number; last: number }

let table: Record<string, Entry> | null = null

function load(): Record<string, Entry> {
  if (table) return table
  try {
    table = JSON.parse(window.localStorage.getItem(KEY) || '{}') as Record<string, Entry>
  } catch {
    table = {}
  }
  return table
}

function save() {
  if (!table) return
  try {
    window.localStorage.setItem(KEY, JSON.stringify(table))
  } catch {
    /* storage unavailable — ranking degrades to insertion order */
  }
}

/** Record that the user opened something. `key` is `<kind>:<id>`. */
export function recordVisit(key: string) {
  const t = load()
  const prev = t[key]
  t[key] = { n: (prev?.n ?? 0) + 1, last: Date.now() }

  // Bound the table: drop the coldest entries rather than growing forever.
  const keys = Object.keys(t)
  if (keys.length > MAX_ENTRIES) {
    keys
      .sort((a, b) => score(t[a]) - score(t[b]))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete t[k])
  }
  save()
}

const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

function score(e: Entry | undefined): number {
  if (!e) return 0
  // Visit count, decayed by age — a thing opened twice today outranks one
  // opened five times a month ago.
  const age = Math.max(0, Date.now() - e.last)
  return e.n * Math.pow(0.5, age / HALF_LIFE_MS)
}

export function frecency(key: string): number {
  return score(load()[key])
}

/** Sort a list by frecency, descending. Ties keep their original order. */
export function byFrecency<T>(items: T[], keyOf: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i, s: frecency(keyOf(item)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item)
}
