import type { GifResult } from './types'

/**
 * Matches:
 * - manual `[[gif:url|alt]]`
 * - duck roast `[[gif:url|alt|duck]]`
 * - duck roast with search query `[[gif:url|alt|duck|query]]`
 */
export const GIF_TOKEN =
  /\[\[gif:(https?:\/\/[^\s|\]]+)\|([^|\]]*)(?:\|duck(?:\|([^|\]]*))?)?\]\]/g

function sanitizeTokenField(value: string): string {
  return value.replace(/[|\]]/g, '').trim()
}

export function buildGifToken(
  g: GifResult,
  opts?: { duck?: boolean; query?: string },
): string {
  const alt = sanitizeTokenField(g.title) || 'gif'
  if (!opts?.duck) return `[[gif:${g.url}|${alt}]]`
  const query = sanitizeTokenField(opts.query ?? '')
  return query
    ? `[[gif:${g.url}|${alt}|duck|${query}]]`
    : `[[gif:${g.url}|${alt}|duck]]`
}

/** Human-readable form for message content shown outside the full chat renderer. */
export function gifPreviewText(content: string): string {
  const replaced = content.replace(GIF_TOKEN, '[GIF]')
  if (replaced === content) return content
  return content.trim().replace(GIF_TOKEN, '[GIF]') === '[GIF]' ? 'sent a GIF' : replaced
}
