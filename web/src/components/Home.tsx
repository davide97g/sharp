import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Kbd } from '../ui'
import { useIsMobile } from '../lib/useMediaQuery'
import { chordFor, formatChord } from '../lib/shortcuts'
import { useStore } from '../store'
import { Sidebar } from './Sidebar'
import { HomeBoard, UpNextBanner } from './home/HomeBoard'
import { useActiveConversations, useMyOpenTasks, useResume } from './home/homeData'

const SIGNALS = Array.from({ length: 12 })

export function Home() {
  const isMobile = useIsMobile()
  // Mobile home is the channel list itself; the board below is a desktop
  // surface, so it never mounts (and never fetches) on phones.
  if (isMobile) return <Sidebar variant="mobile" />
  return <HomeDesktop />
}

function HomeDesktop() {
  const navigate = useNavigate()
  const setQuickSwitcher = useStore((state) => state.setQuickSwitcher)
  const setSearchOpen = useStore((state) => state.setSearchOpen)
  const sharpyEnabled = useStore((state) => state.sharpyEnabled)
  const setSharpyOpen = useStore((state) => state.setSharpyOpen)
  const sendSharpy = useStore((state) => state.sendSharpy)
  const [question, setQuestion] = useState('')
  const [previewMessage, setPreviewMessage] = useState('')

  // The screen has two states, and which one you get is a fact about you rather
  // than a setting: an empty workspace gets the full welcome, a workspace you
  // have history in gets the board and a header-sized identity.
  const resume = useResume()
  const conversations = useActiveConversations()
  const returning = resume.length > 0 || conversations.length > 0

  function submitSharpy(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = question.trim()
    if (!text) return
    if (sharpyEnabled) {
      setSharpyOpen(true)
      void sendSharpy(text)
      setQuestion('')
      return
    }
    setPreviewMessage("Sharpy is still in preview — your question wasn't sent.")
  }

  return (
    <div className={`home-welcome ${returning ? 'home-welcome-console' : ''}`}>
      <div className="home-grid" aria-hidden="true" />
      <div className="home-signals" aria-hidden="true">
        {SIGNALS.map((_, index) => (
          <span key={index} className="home-signal" />
        ))}
      </div>

      <main className="home-welcome-content">
        {returning ? <ConsoleHeader /> : <WelcomeIdentity />}

        {returning && <UpNextBanner />}

        {!returning && (
          <div className="home-quick-grid">
            <section aria-labelledby="home-start-title">
              <h2 id="home-start-title">Start</h2>
              <WelcomeAction
                icon={<MessageIcon />}
                label="Jump to a conversation"
                shortcut={formatChord(chordFor('palette.open'))}
                onClick={() => setQuickSwitcher(true)}
              />
              <WelcomeAction
                icon={<SearchIcon />}
                label="Search every message"
                shortcut={formatChord(chordFor('search.open'))}
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
        )}

        <form className="ask-sharpy" onSubmit={submitSharpy}>
          <label htmlFor="ask-sharpy-input" className="ask-sharpy-label">
            <SparkIcon />
            <span>Ask Sharpy</span>
            {!sharpyEnabled && <span className="ask-sharpy-badge">Preview</span>}
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
            {sharpyEnabled
              ? 'Answers grounded in your workspace messages and docs.'
              : previewMessage || 'AI workspace answers are coming soon.'}
          </p>
        </form>

        {returning && (
          <>
            <div className="home-strip">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setQuickSwitcher(true)}
                iconRight={<Kbd>{formatChord(chordFor('palette.open'))}</Kbd>}
              >
                Jump to…
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setSearchOpen(true)}
                iconRight={<Kbd>{formatChord(chordFor('search.open'))}</Kbd>}
              >
                Search
              </Button>
              <Button variant="ghost" size="xs" onClick={() => navigate('/docs')}>
                Docs
              </Button>
              <Button variant="ghost" size="xs" onClick={() => navigate('/canvas')}>
                Canvas
              </Button>
            </div>
            <HomeBoard />
          </>
        )}

        <p className="home-sidebar-hint">
          <Kbd>{formatChord(chordFor('sidebar.toggle'))}</Kbd>
          <span>Toggle sidebar</span>
        </p>
      </main>
    </div>
  )
}

/** First-run identity: the mark at full size, because there is nothing else yet. */
function WelcomeIdentity() {
  return (
    <section className="home-identity" aria-labelledby="home-title">
      <div className="home-mark" aria-hidden="true">
        <span className="home-mark-orbit home-mark-orbit-outer" />
        <span className="home-mark-orbit home-mark-orbit-inner" />
        <span className="home-mark-glyph">#</span>
      </div>
      <p className="home-kicker">Your workspace is ready</p>
      <h1 id="home-title">sharp</h1>
      <p className="home-tagline">Conversations, docs, and ideas. Pick up anywhere.</p>
    </section>
  )
}

/**
 * Returning identity: the same mark, shrunk to a header, with a status line of
 * the counts that decide what you do next. Zero counts drop out rather than
 * reading "0 unread" — an empty segment is noise.
 */
function ConsoleHeader() {
  const channels = useStore((state) => state.channels)
  const tasks = useMyOpenTasks()
  const unread = channels.reduce((n, channel) => n + (channel.unread_count ? 1 : 0), 0)

  const today = new Date().toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
  const status = [
    today,
    unread ? `${unread} unread` : null,
    tasks.length ? `${tasks.length} open ${tasks.length === 1 ? 'task' : 'tasks'}` : null,
  ].filter(Boolean)

  return (
    <header className="home-console-header">
      <div className="home-mark" aria-hidden="true">
        <span className="home-mark-orbit home-mark-orbit-outer" />
        <span className="home-mark-glyph">#</span>
      </div>
      <h1>sharp</h1>
      <p className="home-console-status">{status.join(' · ')}</p>
    </header>
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
      {shortcut ? <Kbd>{shortcut}</Kbd> : <ChevronIcon />}
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
