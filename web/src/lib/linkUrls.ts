// Client-side URL extraction — the encrypted-DM half of link previews.
//
// Contract: docs/arch/01-core.md ("Link previews").
//
// **This must stay in step with `extract_urls` in server/src/unfurl.rs.** The server
// does the extraction for plaintext messages; for an E2EE DM it cannot (the content
// is ciphertext), so the client decrypts and runs the same rules here before asking
// `POST /unfurl/resolve` for each URL. Two implementations of one rule is the price
// of end-to-end encryption; a divergence just means the same message unfurls
// differently in a DM than in a channel.
//
// Skipped, exactly as on the server: code fences and inline code, markdown link and
// image targets (which is what GIF chips are), and `<https://…>` — the "post the
// link, keep the card" form.

/** Cards per message, same ceiling as the server. */
export const MAX_PREVIEWS_PER_MESSAGE = 3

const TRAILING = new Set(['.', ',', ';', ':', '!', '?', '"', "'", '»', '”', '’'])

function stripFenced(text: string): string {
  let out = ''
  let rest = text
  for (;;) {
    const start = rest.indexOf('```')
    if (start === -1) break
    out += rest.slice(0, start)
    rest = rest.slice(start + 3)
    const end = rest.indexOf('```')
    if (end === -1) return out
    rest = rest.slice(end + 3)
  }
  return out + rest
}

function stripInline(text: string): string {
  let out = ''
  let rest = text
  for (;;) {
    const start = rest.indexOf('`')
    if (start === -1) break
    out += rest.slice(0, start)
    rest = rest.slice(start + 1)
    const end = rest.indexOf('`')
    if (end === -1) return out
    rest = rest.slice(end + 1)
  }
  return out + rest
}

function count(text: string, ch: string): number {
  let n = 0
  for (const c of text) if (c === ch) n++
  return n
}

/** Drop sentence punctuation and brackets the URL never opened. */
function trimTail(raw: string): string {
  let end = raw.length
  for (;;) {
    const slice = raw.slice(0, end)
    const last = slice.charAt(slice.length - 1)
    if (!last) break
    const drop =
      TRAILING.has(last) ||
      (last === ')' && count(slice, '(') < count(slice, ')')) ||
      (last === ']' && count(slice, '[') < count(slice, ']')) ||
      (last === '}' && count(slice, '{') < count(slice, '}'))
    if (!drop) break
    end -= last.length
  }
  return raw.slice(0, end)
}

/** The linkable URLs in a message, in order, deduplicated, capped. */
export function extractUrls(content: string): string[] {
  const text = stripInline(stripFenced(content))
  const out: string[] = []
  const scheme = /https?:\/\//gi
  let match: RegExpExecArray | null
  while ((match = scheme.exec(text)) !== null) {
    const start = match.index
    const suppressed =
      (start >= 2 && text[start - 1] === '(' && text[start - 2] === ']') ||
      (start >= 1 && text[start - 1] === '<')
    let end = start
    while (end < text.length && !/[\s<>"`|]/.test(text[end])) end++
    scheme.lastIndex = Math.max(end, start + 1)
    const url = trimTail(text.slice(start, end))
    if (suppressed || !url || out.includes(url)) continue
    out.push(url)
    if (out.length >= MAX_PREVIEWS_PER_MESSAGE) break
  }
  return out
}
