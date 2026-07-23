import { useStore } from '../../store'
import { Modal } from '../Modal'

/**
 * Choose how much of the Privacy Shield to pause for 10 minutes: just one
 * conversation (when opened from a channel/DM overlay) or everything.
 */
export function StreamRevealConfirm({
  channelId,
  channelName,
  onClose,
}: {
  channelId?: string
  channelName?: string
  onClose: () => void
}) {
  const revealStreamAll = useStore((s) => s.revealStreamAll)
  const revealStreamChannel = useStore((s) => s.revealStreamChannel)

  return (
    <Modal title="Pause the Privacy Shield?" onClose={onClose}>
      <p className="text-sm text-[var(--color-text-dim)]">
        Revealed content is visible to anyone watching your screen for the next
        10 minutes. The shield re-arms on its own when time runs out.
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {channelId && (
          <button
            type="button"
            onClick={() => {
              revealStreamChannel(channelId)
              onClose()
            }}
            className="group flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/60 px-3.5 py-3 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]/40"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
              <ChatIcon />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-[var(--color-text)]">
                Just this conversation
              </span>
              <span className="block truncate text-[11px] text-[var(--color-text-faint)]">
                {channelName ? `Reveal ${channelName} only` : 'Reveal only the open conversation'}
                {' — everything else stays hidden'}
              </span>
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            revealStreamAll()
            onClose()
          }}
          className="group flex items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-3 text-left transition hover:border-red-500/70 hover:bg-red-500/10"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-500/15 text-red-400">
            <EyeIcon />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-[var(--color-text)]">Everything</span>
            <span className="block text-[11px] text-[var(--color-text-faint)]">
              All private chats, previews, and your email become visible
            </span>
          </span>
        </button>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-4 py-2 text-sm font-semibold text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          Keep everything hidden
        </button>
      </div>
    </Modal>
  )
}

function ChatIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5h16v11H8l-4 4V5Z" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  )
}
