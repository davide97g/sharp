import { Fragment, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { navigateTo } from '../lib/nav'
import { useStore } from '../store'

// Resource-chip matcher: [[doc:<uuid>|<title>]] or [[canvas:<uuid>|<title>]].
const RESOURCE_TOKEN = /\[\[(doc|canvas):([0-9a-f-]{36})\|([^\]]*)\]\]/g
// Fallback single-word mention (when the name isn't in the known directory).
const WORD_MENTION = /^[\w][\w-]*/

function ResourceChip({
  kind,
  id,
  title,
}: {
  kind: 'doc' | 'canvas'
  id: string
  title: string
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigateTo(`/${kind === 'canvas' ? 'x' : 'd'}/${id}`)
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 align-baseline text-[0.85em] font-medium text-[var(--color-accent-hover)] hover:border-[var(--color-accent)]"
    >
      <span>{kind === 'canvas' ? '🎨' : '📄'}</span>
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
function highlightMentions(text: string, keyPrefix: string, names: string[]): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  while (i < text.length) {
    const at = text.indexOf('@', i)
    if (at === -1) {
      out.push(text.slice(i))
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
      if (at > i) out.push(text.slice(i, at))
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
      out.push(text.slice(i, at + 1))
      i = at + 1
    }
  }
  return out
}

/** Split a text run on resource chips, highlighting mentions in the gaps. */
function highlightString(text: string, keyPrefix: string, names: string[]): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  RESOURCE_TOKEN.lastIndex = 0
  let i = 0
  while ((m = RESOURCE_TOKEN.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <Fragment key={`${keyPrefix}-t${i}`}>
          {highlightMentions(text.slice(last, m.index), `${keyPrefix}-t${i}`, names)}
        </Fragment>,
      )
    }
    out.push(
      <ResourceChip
        key={`${keyPrefix}-r${i}`}
        kind={m[1] as 'doc' | 'canvas'}
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
        {highlightMentions(text.slice(last), `${keyPrefix}-t${i}`, names)}
      </Fragment>,
    )
  }
  return out
}

function processChildren(children: ReactNode, keyPrefix: string, names: string[]): ReactNode {
  if (typeof children === 'string') return highlightString(children, keyPrefix, names)
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === 'string' ? (
        <Fragment key={`${keyPrefix}-${i}`}>
          {highlightString(c, `${keyPrefix}-${i}`, names)}
        </Fragment>
      ) : (
        c
      ),
    )
  }
  return children
}

function makeComponents(names: string[]): Components {
  const p = (children: ReactNode, prefix: string) => processChildren(children, prefix, names)
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
  }
}

export function Markdown({ content }: { content: string }) {
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
  const components = useMemo(() => makeComponents(names), [names])
  return (
    <div className="md text-[0.94rem] text-[var(--color-text)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  )
}
