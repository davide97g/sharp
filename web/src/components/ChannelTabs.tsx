import { useNavigate } from 'react-router-dom'

type Tab = 'chat' | 'docs' | 'canvas'

// Slack-style tab strip shown at the top of a channel/DM pane. Switches between
// the chat message view and the channel's docs / canvas galleries while staying
// in chat mode (the channel sidebar stays put — opening an item then routes to
// the full editor under /d/:id or /x/:id).
export function ChannelTabs({ channelId, active }: { channelId: string; active: Tab }) {
  const navigate = useNavigate()

  const tabs: { key: Tab; label: string; to: string; icon: React.ReactNode }[] = [
    { key: 'chat', label: 'Messages', to: `/c/${channelId}`, icon: <ChatIcon /> },
    { key: 'docs', label: 'Docs', to: `/c/${channelId}/docs`, icon: <DocIcon /> },
    { key: 'canvas', label: 'Canvas', to: `/c/${channelId}/canvas`, icon: <CanvasIcon /> },
  ]

  return (
    <div className="flex items-center gap-1 border-b border-[var(--color-border)] px-3">
      {tabs.map((t) => {
        const on = t.key === active
        return (
          <button
            key={t.key}
            onClick={() => navigate(t.to)}
            aria-current={on ? 'page' : undefined}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${
              on
                ? 'border-[var(--color-accent)] text-[var(--color-text)]'
                : 'border-transparent text-[var(--color-text-faint)] hover:text-[var(--color-text)]'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </svg>
  )
}

function CanvasIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <circle cx="16.5" cy="7.5" r="3.5" />
      <path d="M7.5 21 3 14h9z" />
    </svg>
  )
}
