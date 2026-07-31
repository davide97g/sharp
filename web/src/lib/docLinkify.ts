// URL → chip/bookmark conversion for docs. One rule set, three entry points,
// all driven from `components/docs/DocEditorInner.tsx`:
//
//   • paste    — a bare URL becomes a bookmark block on an empty block, or an
//                inline chip inside a line of text
//   • typing   — a URL followed by whitespace in the block being edited turns
//                into a chip as soon as it is terminated
//   • backfill — a one-shot pass when a doc opens with plain-text URLs already
//                in it (docs written before chips existed)
//
// Chip labels come from `POST /unfurl/resolve` — the same unfurler chat uses —
// and are **stored in the chip's props**. That means a reader renders the chip
// with no network call at all: only the person who created it unfurls, exactly
// like the encrypted-DM path. Resolution is best-effort; a rate-limit or a dead
// link leaves the chip labelled with `linkLabel()` and it still works as a link.
//
// The URL grammar mirrors `extractUrls` (see linkUrls.ts) by reusing its tail
// trimming, so a URL is chipped in a doc exactly where it would unfurl in chat.

import { linkLabel, resolvePreview } from './linkPreviews'
import { trimUrlTail } from './linkUrls'

export type UrlChipProps = { url: string; title: string; favicon: string }

export type UrlChip = { type: 'urlchip'; props: UrlChipProps }

/** A URL found inside a run of text, with the slice it occupies. */
export type UrlRange = { start: number; end: number; url: string }

const SCHEME = /https?:\/\//gi

/** Every URL in a text run, in order, with positions — the typing/backfill input. */
export function findUrlRanges(text: string): UrlRange[] {
  const out: UrlRange[] = []
  SCHEME.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SCHEME.exec(text)) !== null) {
    const start = match.index
    let end = start
    while (end < text.length && !/[\s<>"`|]/.test(text[end])) end++
    SCHEME.lastIndex = Math.max(end, start + 1)
    const url = trimUrlTail(text.slice(start, end))
    if (!url) continue
    out.push({ start, end: start + url.length, url })
  }
  return out
}

/** The URL if the whole string is one (a paste of nothing but a link), else null. */
export function bareUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!/^https?:\/\//i.test(trimmed) || /\s/.test(trimmed)) return null
  const url = trimUrlTail(trimmed)
  return url || null
}

/** An unresolved chip — renders as `linkLabel(url)` until a title lands. */
export function chipFor(url: string, title = '', favicon = ''): UrlChip {
  return { type: 'urlchip', props: { url, title, favicon } }
}

/**
 * Chip props with the unfurled title/favicon filled in when the resolve lands in
 * time. Never throws and never blocks longer than the resolve itself: a failure
 * is just a chip that shows its URL.
 */
export async function resolveChip(url: string): Promise<UrlChip> {
  const preview = await resolvePreview(url)
  return chipFor(url, preview?.title ?? '', preview?.favicon_url ?? '')
}

/** Label a chip shows when it has no unfurled title (also the aria/text fallback). */
export function chipLabel(props: UrlChipProps): string {
  return props.title || linkLabel(props.url)
}

// ── Inline-content rewriting ─────────────────────────────────────────────────────────
//
// BlockNote gives a block's content as an array of inline items; a plain run is
// `{ type: 'text', text, styles }`. Splitting a run at a URL means replacing one
// item with up to three (text before, chip, text after). Code-styled runs are
// skipped for the same reason `extract_urls` skips inline code: a URL inside
// backticks is being shown, not linked.

type TextItem = { type: 'text'; text: string; styles?: Record<string, unknown> }
type LinkItem = { type: 'link'; href: string; content?: unknown }
type InlineItem = TextItem | LinkItem | UrlChip | { type: string; [key: string]: unknown }

function isLinkableText(item: InlineItem): item is TextItem {
  if (item.type !== 'text') return false
  const styles = (item as TextItem).styles
  return !styles || styles.code !== true
}

/**
 * A bare auto-link: BlockNote turns a URL you finish typing into a `link` inline
 * node labelled with the URL itself. That is the same thing a chip says, so it is
 * chipped too. A link carrying *custom* text ("the docs" → href) is left alone —
 * someone chose that label.
 */
function bareLinkUrl(item: InlineItem): string | null {
  if (item.type !== 'link') return null
  const { href, content } = item as LinkItem
  if (!href || !Array.isArray(content)) return null
  const text = content
    .map((part) => ((part as TextItem)?.type === 'text' ? (part as TextItem).text : ''))
    .join('')
    .trim()
  return text === href || text === trimUrlTail(href) ? href : null
}

/**
 * Split a content array on its URLs, returning `null` when there is nothing to
 * do (the overwhelmingly common case, so callers can skip the write entirely).
 *
 * `titles` supplies already-known labels; anything missing produces an
 * unresolved chip that fills itself in on first render.
 *
 * `only` restricts conversion to URLs terminated by whitespace — what the typing
 * pass wants, so a URL still being typed is left alone until it is finished.
 */
export function linkifyContent(
  content: readonly unknown[],
  opts: { titles?: Map<string, UrlChipProps>; terminatedOnly?: boolean } = {},
): InlineItem[] | null {
  const out: InlineItem[] = []
  let changed = false
  const items = content as InlineItem[]
  for (let i = 0; i < items.length; i++) {
    const raw = items[i]
    const linked = bareLinkUrl(raw)
    if (linked) {
      // An auto-link *grows* as it is typed: `https://www.youtube` is already a
      // link before the rest of the URL arrives. Chipping it then would freeze
      // half a URL into an atom and leave the tail as loose text, so the typing
      // pass waits for something to follow it.
      if (opts.terminatedOnly && !isTerminated(items[i + 1])) {
        out.push(raw)
        continue
      }
      const known = opts.titles?.get(linked)
      out.push(chipFor(linked, known?.title ?? '', known?.favicon ?? ''))
      changed = true
      continue
    }
    if (!isLinkableText(raw)) {
      out.push(raw)
      continue
    }
    const { text, styles } = raw
    const ranges = findUrlRanges(text)
    if (ranges.length === 0) {
      out.push(raw)
      continue
    }
    let cursor = 0
    for (const range of ranges) {
      // The typing pass waits for actual whitespace after the URL. "Not at the
      // end of the run" is not enough: tail-trimming makes `https://www.` report
      // a range ending before the dot, and chipping there would freeze a URL that
      // is three keystrokes from being finished.
      if (opts.terminatedOnly && !/\s/.test(text[range.end] ?? '')) continue
      if (range.start > cursor) out.push({ type: 'text', text: text.slice(cursor, range.start), styles })
      const known = opts.titles?.get(range.url)
      out.push(chipFor(range.url, known?.title ?? '', known?.favicon ?? ''))
      cursor = range.end
      changed = true
    }
    if (cursor < text.length) out.push({ type: 'text', text: text.slice(cursor), styles })
  }
  return changed ? out : null
}

/** Does this sibling end the URL before it? Anything but more of the same word. */
function isTerminated(next: InlineItem | undefined): boolean {
  if (!next) return false
  if (next.type !== 'text') return true
  return /^\s/.test((next as TextItem).text ?? '')
}

/** True for BlockNote's own auto-link of a bare URL (see `bareLinkUrl`). */
export function isBareAutoLink(item: unknown): boolean {
  return bareLinkUrl(item as InlineItem) !== null
}

/** Every URL a content array would chip — the resolve list for the backfill pass. */
export function urlsInContent(content: readonly unknown[]): string[] {
  const out: string[] = []
  for (const item of content as InlineItem[]) {
    const linked = bareLinkUrl(item)
    if (linked) {
      if (!out.includes(linked)) out.push(linked)
      continue
    }
    if (!isLinkableText(item)) continue
    for (const range of findUrlRanges(item.text)) {
      if (!out.includes(range.url)) out.push(range.url)
    }
  }
  return out
}

/**
 * Resolve many URLs without tripping the server's per-user resolve limit: a few
 * at a time, and the moment one comes back empty-handed the rest still run (each
 * failure is independent).
 */
export async function resolveChipProps(
  urls: string[],
  concurrency = 3,
): Promise<Map<string, UrlChipProps>> {
  const titles = new Map<string, UrlChipProps>()
  const queue = [...urls]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const url = queue.shift()
      if (!url) return
      const chip = await resolveChip(url)
      if (chip.props.title || chip.props.favicon) titles.set(url, chip.props)
    }
  })
  await Promise.all(workers)
  return titles
}
