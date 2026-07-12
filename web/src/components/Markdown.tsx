import { Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Mention matcher: @ followed by word chars.
const MENTION_TOKEN = /@[\w][\w-]*/g

function highlightString(text: string, keyPrefix: string): ReactNode[] {
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
