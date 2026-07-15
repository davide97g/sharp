import data from '@emoji-mart/data'
import type { EmojiMartData } from '@emoji-mart/data'

export type EmojiMatch = {
  id: string
  name: string
  native: string
  /** Shortcode without surrounding colons, e.g. `fire`. */
  shortcode: string
}

type Indexed = {
  id: string
  name: string
  native: string
  keywords: string[]
  aliases: string[]
}

// Casual Slack-style aliases that emoji-mart doesn't ship.
const EXTRA_ALIASES: Record<string, string> = {
  lol: 'joy',
  lmao: 'joy',
  haha: 'joy',
  rofl: 'rolling_on_the_floor_laughing',
  thumbsup: '+1',
  thumbsdown: '-1',
  smile: 'slightly_smiling_face',
  sad: 'cry',
  check: 'white_check_mark',
  ok: 'ok_hand',
  party: 'tada',
  celebrate: 'tada',
}

const mart = data as EmojiMartData

const byId = new Map<string, Indexed>()
const aliasToId = new Map<string, string>(Object.entries(mart.aliases ?? {}))

for (const [alias, id] of Object.entries(EXTRA_ALIASES)) {
  if (!aliasToId.has(alias)) aliasToId.set(alias, id)
}

for (const emoji of Object.values(mart.emojis)) {
  const native = emoji.skins[0]?.native
  if (!native) continue
  byId.set(emoji.id, {
    id: emoji.id,
    name: emoji.name,
    native,
    keywords: emoji.keywords ?? [],
    aliases: [],
  })
}

for (const [alias, id] of aliasToId) {
  const entry = byId.get(id)
  if (entry) entry.aliases.push(alias)
}

function toMatch(entry: Indexed, shortcode = entry.id): EmojiMatch {
  return {
    id: entry.id,
    name: entry.name,
    native: entry.native,
    shortcode,
  }
}

/** Resolve an exact shortcode (with or without colons) to a native emoji. */
export function resolveEmojiShortcode(raw: string): EmojiMatch | null {
  const id = raw.replace(/^:|:$/g, '').toLowerCase()
  if (!id) return null
  const canonical = aliasToId.get(id) ?? id
  const entry = byId.get(canonical)
  if (!entry) return null
  return toMatch(entry, id)
}

/**
 * Ranked shortcode search for the composer `:…` picker.
 * Prefer id/alias prefix matches, then keywords, then name.
 */
export function searchEmojis(query: string, limit = 8): EmojiMatch[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '')
  if (!q) {
    // Empty `: ` — show a small popular starter set.
    const popular = [
      'grinning',
      'joy',
      'heart',
      'fire',
      '+1',
      'tada',
      'thinking_face',
      'eyes',
    ]
    return popular
      .map((id) => byId.get(id))
      .filter((e): e is Indexed => !!e)
      .slice(0, limit)
      .map((e) => toMatch(e))
  }

  type Scored = { entry: Indexed; score: number; shortcode: string }
  const scored: Scored[] = []

  for (const entry of byId.values()) {
    let score = 0
    let shortcode = entry.id

    if (entry.id === q) {
      score = 100
    } else if (entry.id.startsWith(q)) {
      score = 80
    } else if (entry.id.includes(q)) {
      score = 50
    }

    for (const alias of entry.aliases) {
      if (alias === q) {
        score = Math.max(score, 95)
        shortcode = alias
      } else if (alias.startsWith(q)) {
        if (score < 75) {
          score = 75
          shortcode = alias
        }
      } else if (alias.includes(q) && score < 45) {
        score = 45
        shortcode = alias
      }
    }

    for (const kw of entry.keywords) {
      if (kw === q) score = Math.max(score, 70)
      else if (kw.startsWith(q)) score = Math.max(score, 55)
      else if (kw.includes(q)) score = Math.max(score, 35)
    }

    const name = entry.name.toLowerCase()
    if (name === q) score = Math.max(score, 65)
    else if (name.startsWith(q)) score = Math.max(score, 40)
    else if (name.includes(q)) score = Math.max(score, 25)

    if (score > 0) scored.push({ entry, score, shortcode })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    return a.entry.id.localeCompare(b.entry.id)
  })

  return scored.slice(0, limit).map((s) => toMatch(s.entry, s.shortcode))
}
