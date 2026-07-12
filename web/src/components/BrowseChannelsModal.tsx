import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './Modal'
import { useStore } from '../store'
import { toastError } from '../lib/toast'

export function BrowseChannelsModal({ onClose }: { onClose: () => void }) {
  const channels = useStore((s) => s.channels)
  const joinChannel = useStore((s) => s.joinChannel)
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [joining, setJoining] = useState<string | null>(null)

  const publicChannels = useMemo(
    () =>
      channels
        .filter((c) => c.kind === 'public')
        .filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels, q],
  )

  async function join(id: string) {
    setJoining(id)
    try {
      await joinChannel(id)
      onClose()
      navigate(`/c/${id}`)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    } finally {
      setJoining(null)
    }
  }

  return (
    <Modal title="Browse channels" onClose={onClose} wide>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search channels…"
        className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
      />
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {publicChannels.length === 0 && (
          <div className="py-8 text-center text-sm text-[var(--color-text-faint)]">
            No public channels found.
          </div>
        )}
        {publicChannels.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-sm font-medium">
                <span className="text-[var(--color-text-faint)]">#</span>
                {c.name}
              </div>
              {c.topic && (
                <div className="truncate text-xs text-[var(--color-text-faint)]">{c.topic}</div>
              )}
            </div>
            {c.is_member ? (
              <button
                onClick={() => {
                  onClose()
                  navigate(`/c/${c.id}`)
                }}
                className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel)]"
              >
                Open
              </button>
            ) : (
              <button
                onClick={() => join(c.id)}
                disabled={joining === c.id}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
              >
                {joining === c.id ? 'Joining…' : 'Join'}
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
