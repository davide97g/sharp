import { Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { navigateTo } from '../lib/nav'

// Mention matcher: @ followed by word chars.
const MENTION_TOKEN = /@[\w][\w-]*/g
// Doc-chip matcher: [[doc:<uuid>|<title>]].
const DOC_TOKEN = /\[\[doc:([0-9a-f-]{36})\|([^\]]*)\]\]/g

function DocChip({ docId, title }: { docId: string; title: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigateTo(`/d/${docId}`)
      }}
      className="mx-0.5 inline-flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 align-baseline text-[0.85em] font-medium text-[var(--color-accent-hover)] hover:border-[var(--color-accent)]"
    >
      <span>📄</span>
      <span>{title || 'Untitled'}</span>
    </button>
  )
}

/** Highlight @mentions inside a plain-text run. */
function highlightMentions(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  MENTION_TOKEN.lastIndex = 0
  let i = 0
  while ((m = MENTION_TOKEN.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span
        key={`${keyPrefix}-m-${i++}`}
        className="rounded bg-[var(--color-accent-soft)] px-1 font-medium text-[var(--color-accent-hover)]"
      >
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Split a text run on doc chips, highlighting mentions in the gaps. */
function highlightString(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  DOC_TOKEN.lastIndex = 0
  let i = 0
  while ((m = DOC_TOKEN.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <Fragment key={`${keyPrefix}-t${i}`}>
          {highlightMentions(text.slice(last, m.index), `${keyPrefix}-t${i}`)}
        </Fragment>,
      )
    }
    out.push(<DocChip key={`${keyPrefix}-d${i}`} docId={m[1]} title={m[2]} />)
    last = m.index + m[0].length
    i++
  }
  if (last < text.length) {
    out.push(
      <Fragment key={`${keyPrefix}-t${i}`}>
        {highlightMentions(text.slice(last), `${keyPrefix}-t${i}`)}
      </Fragment>,
    )
  }
  return out
}

function processChildren(children: ReactNode, keyPrefix: string): ReactNode {
  if (typeof children === 'string') return highlightString(children, keyPrefix)
  if (Array.isArray(children)) {
    return children.map((c, i) =>
      typeof c === 'string' ? (
        <Fragment key={`${keyPrefix}-${i}`}>{highlightString(c, `${keyPrefix}-${i}`)}</Fragment>
      ) : (
        c
      ),
    )
  }
  return children
}

const components: Components = {
  p: ({ children }) => <p>{processChildren(children, 'p')}</p>,
  li: ({ children }) => <li>{processChildren(children, 'li')}</li>,
  strong: ({ children }) => <strong>{processChildren(children, 'strong')}</strong>,
  em: ({ children }) => <em>{processChildren(children, 'em')}</em>,
  td: ({ children }) => <td>{processChildren(children, 'td')}</td>,
  th: ({ children }) => <th>{processChildren(children, 'th')}</th>,
  h1: ({ children }) => <h1>{processChildren(children, 'h1')}</h1>,
  h2: ({ children }) => <h2>{processChildren(children, 'h2')}</h2>,
  h3: ({ children }) => <h3>{processChildren(children, 'h3')}</h3>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
}

export function Markdown({ content }: { content: string }) {
  return (
    <div className="md text-[0.94rem] text-[var(--color-text)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  )
}
