import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal } from './Modal'
import { useStore } from '../store'
import { toastError } from '../lib/toast'

const NAME_RE = /^[a-z0-9-]{1,50}$/

export function CreateChannelModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [kind, setKind] = useState<'public' | 'private'>('public')
  const [busy, setBusy] = useState(false)
  const createChannel = useStore((s) => s.createChannel)
  const navigate = useNavigate()

  const normalized = name.trim().toLowerCase()
  const valid = NAME_RE.test(normalized)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    try {
      const ch = await createChannel({ name: normalized, kind, topic: topic.trim() || undefined })
      onClose()
      navigate(`/c/${ch.id}`)
    } catch (err) {
      if (err instanceof Error) toastError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Create a channel" onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--color-text-dim)]">Name</span>
          <div className="flex items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]">
            <span className="text-[var(--color-text-faint)]">#</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="marketing"
              className="flex-1 bg-transparent px-2 py-2.5 text-sm focus:outline-none"
            />
          </div>
          <span className="text-[11px] text-[var(--color-text-faint)]">
            Lowercase letters, numbers, and hyphens. 1–50 chars.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-[var(--color-text-dim)]">Topic (optional)</span>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="What's this channel about?"
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
        </label>

        <div className="flex gap-2">
          <VisibilityOption
            active={kind === 'public'}
            onClick={() => setKind('public')}
            label="Public"
            desc="Anyone can join"
          />
          <VisibilityOption
            active={kind === 'private'}
            onClick={() => setKind('private')}
            label="Private"
            desc="Invite only"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </form>
    </Modal>
  )
}

function VisibilityOption({
  active,
  onClick,
  label,
  desc,
}: {
  active: boolean
  onClick: () => void
  label: string
  desc: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg border px-3 py-2 text-left transition ${
        active
          ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] hover:bg-[var(--color-panel-2)]'
      }`}
    >
      <div className="text-sm font-medium">{label}</div>
      <div className="text-[11px] text-[var(--color-text-faint)]">{desc}</div>
    </button>
  )
}
