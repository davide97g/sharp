import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import type { Channel } from '../lib/types'

type PickItem = { id: string; title: string; channelName?: string }

// Find an open, unclosed `[[` run ending at the caret.
function detectDocTrigger(value: string, caret: number): { start: number; query: string } | null {
  const upto = value.slice(0, caret)
  const m = /\[\[([^\]\n]*)$/.exec(upto)
  if (!m) return null
  return { start: m.index, query: m[1] }
}

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

  // --- [[ doc picker state ---
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null)
  const [results, setResults] = useState<PickItem[]>([])
  const [sel, setSel] = useState(0)
  const caretRef = useRef(0)

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

  // Debounced doc search for the picker.
  useEffect(() => {
    if (trigger === null) {
      setResults([])
      return
    }
    const q = trigger.query.trim()
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        if (q) {
          const res = await api.docSearch(q, 8)
          if (!cancelled) {
            setResults(res.results.map((d) => ({ id: d.id, title: d.title || 'Untitled', channelName: d.channel_name })))
            setSel(0)
          }
        } else {
          const state = useStore.getState()
          const chName: Record<string, string> = {}
          for (const c of state.channels) chName[c.id] = c.kind === 'dm' ? c.dm_user?.display_name ?? '' : c.name
          const recent = Object.values(state.docsByChannel)
            .flat()
            .filter((d) => !d.deleted_at)
            .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
            .slice(0, 8)
            .map((d) => ({ id: d.id, title: d.title || 'Untitled', channelName: chName[d.channel_id] }))
          if (!cancelled) {
            setResults(recent)
            setSel(0)
          }
        }
      } catch {
        /* ignore */
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trigger])

  const pickerOpen = trigger !== null && results.length > 0

  function syncTrigger() {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    caretRef.current = caret
    setTrigger(detectDocTrigger(el.value, caret))
  }

  function pick(item: PickItem) {
    if (!trigger) return
    const before = value.slice(0, trigger.start)
    const after = value.slice(caretRef.current)
    const token = `[[doc:${item.id}|${item.title || 'Untitled'}]]`
    const next = before + token + after
    setValue(next)
    setTrigger(null)
    setResults([])
    const pos = (before + token).length
    requestAnimationFrame(() => {
      const el = ref.current
      if (el) {
        el.focus()
        el.setSelectionRange(pos, pos)
      }
    })
  }

  async function doSend() {
    const content = value.trim()
    if (!content || sending) return
    setSending(true)
    const prev = value
    setValue('')
    setTrigger(null)
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
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => Math.min(s + 1, results.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => Math.max(s - 1, 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        pick(results[sel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setTrigger(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    caretRef.current = e.target.selectionStart ?? e.target.value.length
    setTrigger(detectDocTrigger(e.target.value, caretRef.current))
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
    <div className="relative px-4 pb-4 pt-1">
      {pickerOpen && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
            Link a doc
          </div>
          {results.map((r, i) => (
            <button
              key={r.id}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(r)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                i === sel ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-panel-2)]'
              }`}
            >
              <span>📄</span>
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {r.channelName && (
                <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
                  #{r.channelName}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={syncTrigger}
          onClick={syncTrigger}
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
