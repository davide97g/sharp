import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useIsMobile } from '../lib/useMediaQuery'
import { useStore } from '../store'
import { Sidebar } from './Sidebar'

const SIGNALS = Array.from({ length: 12 })

export function Home() {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const setQuickSwitcher = useStore((state) => state.setQuickSwitcher)
  const setSearchOpen = useStore((state) => state.setSearchOpen)
  const [question, setQuestion] = useState('')
  const [previewMessage, setPreviewMessage] = useState('')

  if (isMobile) {
    return <Sidebar variant="mobile" />
  }

  function submitSharpy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!question.trim()) return
    setPreviewMessage("Sharpy is still in preview — your question wasn't sent.")
  }

  return (
    <div className="home-welcome">
      <div className="home-grid" aria-hidden="true" />
      <div className="home-signals" aria-hidden="true">
        {SIGNALS.map((_, index) => (
          <span key={index} className="home-signal" />
        ))}
      </div>

      <main className="home-welcome-content">
        <section className="home-identity" aria-labelledby="home-title">
          <div className="home-mark" aria-hidden="true">
            <span className="home-mark-orbit home-mark-orbit-outer" />
            <span className="home-mark-orbit home-mark-orbit-inner" />
            <span className="home-mark-glyph">#</span>
          </div>
          <p className="home-kicker">Your workspace is ready</p>
          <h1 id="home-title">sharp</h1>
          <p className="home-tagline">
            Conversations, docs, and ideas. Pick up anywhere.
          </p>
        </section>

        <div className="home-quick-grid">
          <section aria-labelledby="home-start-title">
            <h2 id="home-start-title">Start</h2>
            <WelcomeAction
              icon={<MessageIcon />}
              label="Jump to a conversation"
              shortcut="⌘K"
              onClick={() => setQuickSwitcher(true)}
            />
            <WelcomeAction
              icon={<SearchIcon />}
              label="Search every message"
              shortcut="⌘F"
              onClick={() => setSearchOpen(true)}
            />
          </section>

          <section aria-labelledby="home-explore-title">
            <h2 id="home-explore-title">Explore</h2>
            <WelcomeAction
              icon={<DocumentIcon />}
              label="Open workspace docs"
              onClick={() => navigate('/docs')}
            />
            <WelcomeAction
              icon={<CanvasIcon />}
              label="Open a shared canvas"
              onClick={() => navigate('/canvas')}
            />
          </section>
        </div>

        <form className="ask-sharpy" onSubmit={submitSharpy}>
          <label htmlFor="ask-sharpy-input" className="ask-sharpy-label">
            <SparkIcon />
            <span>Ask Sharpy</span>
            <span className="ask-sharpy-badge">Preview</span>
          </label>
          <div className="ask-sharpy-field">
            <input
              id="ask-sharpy-input"
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value)
                if (previewMessage) setPreviewMessage('')
              }}
              placeholder="Ask about a project, decision, or next step…"
              autoComplete="off"
            />
            <button type="submit" disabled={!question.trim()} aria-label="Ask Sharpy">
              <ArrowUpIcon />
            </button>
          </div>
          <p className="ask-sharpy-hint" aria-live="polite">
            {previewMessage || 'AI workspace answers are coming soon.'}
          </p>
        </form>

        <p className="home-sidebar-hint">
          <kbd>\</kbd>
          <span>Toggle sidebar</span>
        </p>
      </main>
    </div>
  )
}

function WelcomeAction({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button type="button" className="home-quick-action" onClick={onClick}>
      <span className="home-quick-icon" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      {shortcut ? <kbd>{shortcut}</kbd> : <ChevronIcon />}
    </button>
  )
}

function MessageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 18.5 3.5 21l1-4.2A8 8 0 1 1 7 18.5Z" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4 4" />
    </svg>
  )
}

function DocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 3.5h7l4 4V20a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M13.5 3.5v4h4M8.5 12h6.5M8.5 16h5" />
    </svg>
  )
}

function CanvasIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <circle cx="8.5" cy="9" r="1.5" />
      <path d="m6.5 17 4-4 2.7 2.7 2.3-2.2 2 2" />
    </svg>
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3c.4 4.7 2.3 6.6 7 7-4.7.4-6.6 2.3-7 7-.4-4.7-2.3-6.6-7-7 4.7-.4 6.6-2.3 7-7Z" />
      <path d="M18.5 16.5c.1 1.5.8 2.2 2.3 2.3-1.5.1-2.2.8-2.3 2.3-.1-1.5-.8-2.2-2.3-2.3 1.5-.1 2.2-.8 2.3-2.3Z" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="home-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 12 6-6 6 6M12 6v12" />
    </svg>
  )
}
