import { Fragment, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GIF_TOKEN } from '../lib/gif'
import { navigateTo } from '../lib/nav'
import { useStore } from '../store'
import { ImageLightbox } from './ImageLightbox'
import { MeetingCard } from './calendar/MeetingCard'
import { PollCard } from './PollCard'

// Chat card token for a scheduled meeting: [[meet:<uuid>|<title>|<start_iso>]].
const MEET_TOKEN = /\[\[meet:([0-9a-f-]{36})\|([^|\]]*)\|([^\]]*)\]\]/g
const POLL_TOKEN = /\[\[poll:([0-9a-f-]{36})(?:\|([^\]]*))?\]\]/g

// Resource-chip matcher: [[doc|canvas|board:<uuid>|<title>]].
const RESOURCE_TOKEN = /\[\[(doc|canvas|board):([0-9a-f-]{36})\|([^\]]*)\]\]/g
// Fallback single-word mention (when the name isn't in the known directory).
const WORD_MENTION = /^[\w][\w-]*/

function ResourceChip({
  kind,
  id,
  title,
}: {
  kind: 'doc' | 'canvas' | 'board'
  id: string
  title: string
}) {
  const prefix = kind === 'canvas' ? 'x' : kind === 'board' ? 'b' : 'd'
  const emoji = kind === 'canvas' ? '🎨' : kind === 'board' ? '🗂️' : '📄'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigateTo(`/${prefix}/${id}`)
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 align-baseline text-[0.85em] font-medium text-[var(--color-accent-hover)] hover:border-[var(--color-accent)]"
    >
      <span>{emoji}</span>
      <span>{title || 'Untitled'}</span>
    </button>
  )
}

/**
 * Highlight @mentions inside a plain-text run. `names` is the directory of known
 * display names, sorted longest-first so a greedy match pills the full name
 * (e.g. "@Ann Marie" beats "@Ann") — mirroring the server's mention detection.
 * Unknown `@handles` fall back to a single-word pill.
 */
// Escape a string for safe use inside a RegExp.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Build a case-insensitive alternation of the query's word tokens (len ≥ 2). */
export function buildHighlightRe(query: string | undefined): RegExp | null {
  if (!query) return null
  const tokens = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .map(escapeRe)
  if (tokens.length === 0) return null
  return new RegExp(`(${tokens.join('|')})`, 'giu')
}

/** Wrap query-term matches in a plain text run with a search-highlight <mark>. */
function queryNodes(text: string, keyPrefix: string, re: RegExp | null): ReactNode {
  if (!re) return text
  re.lastIndex = 0
  const parts = text.split(re)
  if (parts.length <= 1) return text
  return parts.map((part, i) =>
    // split() with a capture group interleaves matches at odd indices.
    i % 2 === 1 ? (
      <mark
        key={`${keyPrefix}-hl${i}`}
        className="rounded bg-yellow-300/40 px-0.5 text-[var(--color-text)]"
      >
        {part}
      </mark>
    ) : (
      <Fragment key={`${keyPrefix}-hs${i}`}>{part}</Fragment>
    ),
  )
}

function highlightMentions(
  text: string,
  keyPrefix: string,
  names: string[],
  re: RegExp | null,
): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) {
      out.push(
        <Fragment key={`${keyPrefix}-r${key++}`}>
          {queryNodes(text.slice(i), `${keyPrefix}-r${key}`, re)}
        </Fragment>,
      )
      break
    }
    // '@' only starts a mention at a word boundary (not inside an email/word).
    const prev = at > 0 ? text[at - 1] : ' '
    const boundaryOk = !/[A-Za-z0-9]/.test(prev)
    let matchLen = 0
    if (boundaryOk) {
      const after = text.slice(at + 1)
      for (const name of names) {
        if (name && after.startsWith(name)) {
          matchLen = name.length
          break
        }
      }
      if (matchLen === 0) {
        const wm = WORD_MENTION.exec(after)
        if (wm) matchLen = wm[0].length
      }
    }
    if (matchLen > 0) {
      if (at > i)
        out.push(
          <Fragment key={`${keyPrefix}-r${key++}`}>
            {queryNodes(text.slice(i, at), `${keyPrefix}-r${key}`, re)}
          </Fragment>,
        )
      out.push(
        <span
          key={`${keyPrefix}-m-${key++}`}
          className="rounded bg-[var(--color-accent-soft)] px-1 font-medium text-[var(--color-accent-hover)]"
        >
          {text.slice(at, at + 1 + matchLen)}
        </span>,
      )
      i = at + 1 + matchLen
    } else {
      // Not a mention — keep the '@' as literal text and move on.
      out.push(
        <Fragment key={`${keyPrefix}-r${key++}`}>
          {queryNodes(text.slice(i, at + 1), `${keyPrefix}-r${key}`, re)}
        </Fragment>,
      )
      i = at + 1
    }
  }
  return out
}

/** Split a text run on resource chips, highlighting mentions in the gaps. */
function highlightString(
  text: string,
  keyPrefix: string,
  names: string[],
  re: RegExp | null,
): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  RESOURCE_TOKEN.lastIndex = 0
  let i = 0
  while ((m = RESOURCE_TOKEN.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <Fragment key={`${keyPrefix}-t${i}`}>
          {highlightMentions(text.slice(last, m.index), `${keyPrefix}-t${i}`, names, re)}
        </Fragment>,
      )
    }
    out.push(
      <ResourceChip
        key={`${keyPrefix}-r${i}`}
        kind={m[1] as 'doc' | 'canvas' | 'board'}
        id={m[2]}
        title={m[3]}
      />,
    )
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) {
    out.push(
      <Fragment key={`${keyPrefix}-t${i}`}>
        {highlightMentions(text.slice(last), `${keyPrefix}-t${i}`, names, re)}
      </Fragment>,
    )
  }
  return out
}

function processChildren(
  children: ReactNode,
  keyPrefix: string,
  names: string[],
  re: RegExp | null,
): ReactNode {
  if (typeof children === 'string') return highlightString(children, keyPrefix, names, re)
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === 'string' ? (
        <Fragment key={`${keyPrefix}-${i}`}>
          {highlightString(c, `${keyPrefix}-${i}`, names, re)}
        </Fragment>
      ) : (
        c
      ),
    )
  }
  return children
}

function makeComponents(names: string[], re: RegExp | null): Components {
  const p = (children: ReactNode, prefix: string) => processChildren(children, prefix, names, re)
  return {
    p: ({ children }) => <p>{p(children, 'p')}</p>,
    li: ({ children }) => <li>{p(children, 'li')}</li>,
    strong: ({ children }) => <strong>{p(children, 'strong')}</strong>,
    em: ({ children }) => <em>{p(children, 'em')}</em>,
    td: ({ children }) => <td>{p(children, 'td')}</td>,
    th: ({ children }) => <th>{p(children, 'th')}</th>,
    h1: ({ children }) => <h1>{p(children, 'h1')}</h1>,
    h2: ({ children }) => <h2>{p(children, 'h2')}</h2>,
    h3: ({ children }) => <h3>{p(children, 'h3')}</h3>,
    a: ({ children, href }) => (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),
    img: ({ src, alt }) => (src ? <MdImage src={src} alt={alt || ''} /> : null),
  }
}

function MdImage({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="my-1 inline-block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left"
        title={alt || undefined}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="block max-h-80 max-w-full rounded-lg border border-[var(--color-border)]"
        />
      </button>
      {open ? <ImageLightbox src={src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

function GifImage({
  url,
  alt,
  query,
}: {
  url: string
  alt: string
  query?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`msg-gif group relative my-1 inline-block max-w-full cursor-zoom-in border-0 bg-transparent p-0 text-left ${query ? 'pb-5' : ''}`}
        title={query || alt}
      >
        <img
          src={url}
          alt={alt}
          loading="lazy"
          className="block max-h-64 max-w-full rounded-lg border border-[var(--color-border)]"
        />
        {query ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 text-center text-[0.72rem] leading-snug text-[var(--color-muted)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            {query}
          </span>
        ) : null}
      </button>
      {open ? <ImageLightbox src={url} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

export function Markdown({
  content,
  highlight,
}: {
  content: string
  highlight?: string
}) {
  const users = useStore((s) => s.users)
  // Known display names, longest-first, for greedy multi-word mention matching.
  const names = useMemo(
    () =>
      Object.values(users)
        .map((u) => u.display_name)
        .filter(Boolean)
        .sort((a, b) => b.length - a.length),
    [users],
  )
  const re = useMemo(() => buildHighlightRe(highlight), [highlight])
  const components = useMemo(() => makeComponents(names, re), [names, re])
  // Collect card tokens (GIF + meeting) in document order, then slice the text
  // between them into markdown runs.
  type Tok =
    | { index: number; length: number; kind: 'gif'; url: string; alt: string; query?: string }
    | { index: number; length: number; kind: 'meet'; id: string; title: string; iso: string }
    | { index: number; length: number; kind: 'poll'; id: string; question: string }
  const toks: Tok[] = []
  let m: RegExpExecArray | null
  GIF_TOKEN.lastIndex = 0
  while ((m = GIF_TOKEN.exec(content)) !== null) {
    const query = m[3]?.trim()
    toks.push({
      index: m.index,
      length: m[0].length,
      kind: 'gif',
      url: m[1],
      alt: m[2],
      ...(query ? { query } : {}),
    })
  }
  MEET_TOKEN.lastIndex = 0
  while ((m = MEET_TOKEN.exec(content)) !== null) {
    toks.push({
      index: m.index,
      length: m[0].length,
      kind: 'meet',
      id: m[1],
      title: m[2],
      iso: m[3],
    })
  }
  POLL_TOKEN.lastIndex = 0
  while ((m = POLL_TOKEN.exec(content)) !== null) {
    toks.push({
      index: m.index,
      length: m[0].length,
      kind: 'poll',
      id: m[1],
      question: m[2] ?? '',
    })
  }
  toks.sort((a, b) => a.index - b.index)

  const parts: Array<
    | { kind: 'text'; content: string }
    | { kind: 'gif'; url: string; alt: string; query?: string }
    | { kind: 'meet'; id: string; title: string; iso: string }
    | { kind: 'poll'; id: string; question: string }
  > = []
  let last = 0
  for (const tok of toks) {
    if (tok.index < last) continue // skip overlapping (shouldn't happen)
    if (tok.index > last) {
      parts.push({ kind: 'text', content: content.slice(last, tok.index) })
    }
    if (tok.kind === 'gif') {
      parts.push({ kind: 'gif', url: tok.url, alt: tok.alt, query: tok.query })
    } else if (tok.kind === 'meet') {
      parts.push({ kind: 'meet', id: tok.id, title: tok.title, iso: tok.iso })
    } else {
      parts.push({ kind: 'poll', id: tok.id, question: tok.question })
    }
    last = tok.index + tok.length
  }

  if (parts.length === 0) {
    return (
      <div className="md text-[0.94rem] text-[var(--color-text)]">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
          {content}
        </ReactMarkdown>
      </div>
    )
  }
  if (last < content.length) parts.push({ kind: 'text', content: content.slice(last) })

  return (
    <div className="md text-[0.94rem] text-[var(--color-text)]">
      {parts.map((part, index) =>
        part.kind === 'gif' ? (
          <GifImage key={index} url={part.url} alt={part.alt} query={part.query} />
        ) : part.kind === 'meet' ? (
          <MeetingCard key={index} id={part.id} title={part.title} iso={part.iso} />
        ) : part.kind === 'poll' ? (
          <PollCard key={index} id={part.id} fallbackQuestion={part.question} />
        ) : (
          <ReactMarkdown
            key={index}
            remarkPlugins={[remarkGfm]}
            components={components}
            skipHtml
          >
            {part.content}
          </ReactMarkdown>
        ),
      )}
    </div>
  )
}
