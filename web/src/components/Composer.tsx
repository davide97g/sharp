import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import type { Channel } from '../lib/types'

export function Composer({
  channel,
  parentId,
  placeholder,
}: {
  channel: Channel
  parentId?: string
  placeholder?: string
}) {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const lastTypingRef = useRef(0)
  const sendMessage = useStore((s) => s.sendMessage)
  const sendTyping = useStore((s) => s.sendTyping)
  const joinChannel = useStore((s) => s.joinChannel)

  const canPost = channel.kind === 'dm' || channel.is_member

  const autosize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  async function doSend() {
    const content = value.trim()
    if (!content || sending) return
    setSending(true)
    const prev = value
    setValue('')
    try {
      await sendMessage(channel.id, content, parentId)
    } catch {
      setValue(prev) // restore on failure
    } finally {
      setSending(false)
      requestAnimationFrame(() => ref.current?.focus())
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    // throttle typing to 1 per 3s
    const now = Date.now()
    if (now - lastTypingRef.current > 3000) {
      lastTypingRef.current = now
      sendTyping(channel.id)
    }
  }

  if (!canPost) {
    return (
      <div className="border-t border-[var(--color-border)] px-4 py-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 text-sm text-[var(--color-text-dim)]">
          <span>You're not a member of this channel.</span>
          {channel.kind === 'public' && (
            <button
              onClick={() => joinChannel(channel.id)}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)]"
            >
              Join
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="px-4 pb-4 pt-1">
      <div className="flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'Message'}
          className="max-h-[260px] flex-1 resize-none bg-transparent py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
        />
        <button
          onClick={doSend}
          disabled={!value.trim() || sending}
          title="Send (Enter)"
          className="mb-0.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  )
}
