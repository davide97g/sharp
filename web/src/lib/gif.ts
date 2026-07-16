import type { GifResult } from './types'

export const GIF_TOKEN = /\[\[gif:(https?:\/\/[^\s|\]]+)\|([^\]]*)\]\]/g

export function buildGifToken(g: GifResult): string {
  const alt = g.title.replace(/[|\]]/g, '').trim() || 'gif'
  return `[[gif:${g.url}|${alt}]]`
}

/** Human-readable form for message content shown outside the full chat renderer. */
export function gifPreviewText(content: string): string {
  const replaced = content.replace(GIF_TOKEN, '[GIF]')
  if (replaced === content) return content
  return content.trim().replace(GIF_TOKEN, '[GIF]') === '[GIF]' ? 'sent a GIF' : replaced
}
