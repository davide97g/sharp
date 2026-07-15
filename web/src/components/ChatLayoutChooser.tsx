import { useState } from 'react'
import type { ChatLayout } from '../lib/types'
import { useStore } from '../store'
import { Modal } from './Modal'

// A small non-interactive mockup of each DM rendering style.
export function ChatLayoutPreview({ layout }: { layout: ChatLayout }) {
  if (layout === 'bubble') {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-[var(--color-ink)] p-3">
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-2xl rounded-bl-sm bg-[var(--color-panel-2)] px-3 py-1.5 text-xs text-[var(--color-text)]">
            Hey! Are we still on for today?
          </div>
        </div>
        <div className="flex justify-end">
          <div className="max-w-[70%] rounded-2xl rounded-br-sm bg-[var(--color-accent-soft)] px-3 py-1.5 text-xs text-[var(--color-text)]">
            Yep — see you at 3 👍
          </div>
        </div>
        <div className="flex justify-start">
          <div className="max-w-[70%] rounded-2xl rounded-bl-sm bg-[var(--color-panel-2)] px-3 py-1.5 text-xs text-[var(--color-text)]">
            Perfect
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg bg-[var(--color-ink)] p-3">
      {[
        { n: 'Alex', t: 'Hey! Are we still on for today?', c: '#e0724d' },
        { n: 'You', t: 'Yep — see you at 3 👍', c: 'var(--color-accent)' },
      ].map((r, i) => (
        <div key={i} className="flex items-start gap-2">
          <span
            className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white"
            style={{ backgroundColor: r.c }}
          >
            {r.n[0]}
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold text-[var(--color-text)]">{r.n}</div>
            <div className="text-xs text-[var(--color-text-dim)]">{r.t}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

function LayoutCard({
  layout,
  title,
  desc,
  selected,
  onSelect,
}: {
  layout: ChatLayout
  title: string
  desc: string
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex-1 rounded-xl border p-2 text-left transition ${
        selected
          ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-text-faint)]'
      }`}
    >
      <ChatLayoutPreview layout={layout} />
      <div className="mt-2 px-1">
        <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
        <div className="text-[11px] text-[var(--color-text-faint)]">{desc}</div>
      </div>
    </button>
  )
}

/** Shared picker body (two cards) used by both the first-run chooser and settings. */
export function ChatLayoutPicker({
  value,
  onChange,
}: {
  value: ChatLayout | null
  onChange: (l: ChatLayout) => void
}) {
  return (
    <div className="flex gap-3">
      <LayoutCard
        layout="bubble"
        title="Bubbles"
        desc="WhatsApp-style. Your messages on the right."
        selected={value === 'bubble'}
        onSelect={() => onChange('bubble')}
      />
      <LayoutCard
        layout="classic"
        title="Classic"
        desc="Slack-style rows with avatars."
        selected={value === 'classic'}
        onSelect={() => onChange('classic')}
      />
    </div>
  )
}

/** First-run modal shown when the user opens a DM before choosing a layout. */
export function ChatLayoutChooser() {
  const setChatLayout = useStore((s) => s.setChatLayout)
  const [choice, setChoice] = useState<ChatLayout>('bubble')
  const [saving, setSaving] = useState(false)

  async function confirm() {
    setSaving(true)
    await setChatLayout(choice)
    setSaving(false)
  }

  return (
    <Modal title="Choose your chat style" onClose={() => void confirm()} wide>
      <p className="mb-3 text-sm text-[var(--color-text-dim)]">
        How should your direct messages look? You can change this anytime in Settings.
      </p>
      <ChatLayoutPicker value={choice} onChange={setChoice} />
      <div className="mt-4 flex justify-end">
        <button
          onClick={confirm}
          disabled={saving}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Use this style'}
        </button>
      </div>
    </Modal>
  )
}
