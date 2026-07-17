import { useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { useNavigate, useParams } from 'react-router-dom'
import remarkGfm from 'remark-gfm'
import { releases } from '../../lib/changelog'
import { faq, howTos } from '../../lib/help'
import { setLastSeenVersion } from '../../lib/whatsNew'

type HelpTab = 'whats-new' | 'faq' | 'how-to'

const tabs: { id: HelpTab; label: string }[] = [
  { id: 'whats-new', label: "What's new" },
  { id: 'faq', label: 'FAQ' },
  { id: 'how-to', label: 'How-to' },
]

export function HelpArea() {
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  const tab: HelpTab = tabs.some(({ id }) => id === tabParam)
    ? (tabParam as HelpTab)
    : 'whats-new'

  useEffect(() => {
    if (tab === 'whats-new') setLastSeenVersion()
  }, [tab])

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-ink)]">
      <header className="shrink-0 border-b border-[var(--color-border)] px-6 pt-6 sm:px-10">
        <div className="mx-auto max-w-4xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M9.7 9a2.4 2.4 0 1 1 3.8 2c-1 .7-1.5 1.1-1.5 2.2" />
                <path d="M12 17h.01" />
              </svg>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--color-text-faint)]">sharp guide</p>
              <h1 className="text-xl font-bold text-[var(--color-text)]">Help</h1>
            </div>
          </div>
          <nav aria-label="Help sections" className="mt-6 flex gap-6">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => navigate(`/help/${id}`)}
                className={`cursor-pointer border-b-2 pb-3 text-sm font-semibold ${
                  tab === id
                    ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                    : 'border-transparent text-[var(--color-text-dim)] hover:text-[var(--color-text)]'
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-10">
        <div className="mx-auto max-w-4xl">
          {tab === 'whats-new' && <WhatsNew />}
          {tab === 'faq' && (
            <section>
              <p className="mb-6 max-w-2xl text-sm text-[var(--color-text-dim)]">
                Quick answers about privacy, calls, notifications, and running sharp.
              </p>
              <div className="md rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 sm:p-7">
                <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{faq}</ReactMarkdown>
              </div>
            </section>
          )}
          {tab === 'how-to' && <HowTo />}
        </div>
      </div>

      <footer className="shrink-0 border-t border-[var(--color-border-soft)] px-6 py-3 text-center text-xs text-[var(--color-text-faint)]">
        Build {__APP_VERSION__}
      </footer>
    </main>
  )
}

function WhatsNew() {
  return (
    <section className="space-y-5">
      <p className="max-w-2xl text-sm text-[var(--color-text-dim)]">
        New features, meaningful improvements, and fixes from each sharp release.
      </p>
      {releases.map((release, index) => (
        <article
          key={release.version}
          className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 sm:p-7"
        >
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border-soft)] pb-5">
            <div>
              {index === 0 && (
                <span className="mb-2 inline-flex rounded-full bg-[var(--color-accent-soft)] px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-accent-hover)]">
                  Latest
                </span>
              )}
              <h2 className="text-lg font-bold text-[var(--color-text)]">{release.name}</h2>
              <p className="mt-1 font-mono text-xs text-[var(--color-text-faint)]">v{release.version}</p>
            </div>
            <time dateTime={release.date} className="text-xs text-[var(--color-text-faint)]">
              {release.date}
            </time>
          </div>
          <div className="md text-sm text-[var(--color-text-dim)]">
            <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{release.body}</ReactMarkdown>
          </div>
        </article>
      ))}
    </section>
  )
}

function HowTo() {
  return (
    <section>
      <p className="mb-6 max-w-2xl text-sm text-[var(--color-text-dim)]">
        Short guides for everyday work and workspace setup.
      </p>
      <div className="space-y-3">
        {howTos.map((guide) => (
          <details
            key={guide.title}
            className="group rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] open:border-[var(--color-accent)]"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-[var(--color-text)] [&::-webkit-details-marker]:hidden">
              {guide.title}
              <svg className="shrink-0 text-[var(--color-text-faint)] group-open:rotate-45" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </summary>
            <div className="md border-t border-[var(--color-border-soft)] px-5 py-4 text-sm text-[var(--color-text-dim)]">
              <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{guide.body}</ReactMarkdown>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
