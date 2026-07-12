import { useMemo, useState } from 'react'
import { Modal } from '../Modal'
import { useStore } from '../../store'
import { toastError, toastSuccess } from '../../lib/toast'
import type { Doc } from '../../lib/types'

export function ShareToChannelModal({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const channels = useStore((s) => s.channels)
  const sendMessage = useStore((s) => s.sendMessage)
  const [busy, setBusy] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const targets = useMemo(() => {
    const query = q.trim().toLowerCase()
    return channels
      .filter((c) => c.kind === 'dm' || c.is_member)
      .filter((c) => {
        const label = c.kind === 'dm' ? c.dm_user?.display_name ?? '' : c.name
        return label.toLowerCase().includes(query)
      })
      .sort((a, b) => {
        const la = a.kind === 'dm' ? a.dm_user?.display_name ?? '' : a.name
        const lb = b.kind === 'dm' ? b.dm_user?.display_name ?? '' : b.name
        return la.localeCompare(lb)
      })
  }, [channels, q])

  async function share(channelId: string) {
    if (busy) return
    setBusy(channelId)
    const content = `[[doc:${doc.id}|${doc.title || 'Untitled'}]]`
    try {
      await sendMessage(channelId, content)
      toastSuccess('Shared to channel')
      onClose()
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title="Share doc to a channel" onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Filter channels…"
        className="mb-3 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
      />
      <div className="max-h-[45vh] space-y-0.5 overflow-y-auto">
        {targets.length === 0 && (
          <div className="px-2 py-6 text-center text-sm text-[var(--color-text-faint)]">
            No channels.
          </div>
        )}
        {targets.map((c) => {
          const label = c.kind === 'dm' ? c.dm_user?.display_name ?? 'Direct message' : c.name
          return (
            <button
              key={c.id}
              onClick={() => share(c.id)}
              disabled={busy !== null}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--color-panel-2)] disabled:opacity-50"
            >
              <span className="text-[var(--color-text-faint)]">{c.kind === 'dm' ? '💬' : '#'}</span>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {busy === c.id && <span className="text-xs text-[var(--color-text-faint)]">Sharing…</span>}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}
