import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { resolveEmojiShortcode, searchEmojis } from '../lib/emoji'
import { toastError } from '../lib/toast'
import { fmtBytes } from '../lib/util'
import { Avatar } from './Avatar'
import type { Attachment, Channel } from '../lib/types'

type Pending = {
  id: string
  name: string
  size: number
  isImage: boolean
  previewUrl?: string
  progress: number
  attachment?: Attachment
  error?: boolean
}

// A completion candidate: person (@), resource (#), or emoji (:).
type PickItem =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'doc' | 'canvas'; id: string; title: string; channelName?: string }
  | { kind: 'emoji'; id: string; name: string; native: string; shortcode: string }

type Trigger = { type: '@' | '#' | ':'; start: number; query: string }

// Detect an open `@` (people), `#` (resource), or `:` (emoji) run ending at the
// caret. The trigger char must sit at a word boundary (start / whitespace / `(`)
// so it doesn't fire inside emails, URLs (`://`), or words. Emoji queries are
// Slack-style shortcode chars only (`a-z0-9_+-`).
function detectTrigger(value: string, caret: number): Trigger | null {
  const upto = value.slice(0, caret)
  const emoji = /(^|[\s(]):([a-zA-Z0-9_+-]*)$/.exec(upto)
  if (emoji) {
    return { type: ':', start: emoji.index + emoji[1].length, query: emoji[2] }
  }
  const m = /(^|[\s(])([@#])([^\s@#]*)$/.exec(upto)
  if (!m) return null
  return { type: m[2] as '@' | '#', start: m.index + m[1].length, query: m[3] }
}

// If the user just typed a closing colon (`:fire:`), expand to the native
// glyph. Returns the replacement value + new caret, or null if no match.
function expandClosedShortcode(
  value: string,
  caret: number,
): { value: string; caret: number } | null {
  const upto = value.slice(0, caret)
  const m = /(^|[\s(]):([a-zA-Z0-9_+]+):$/.exec(upto)
  if (!m) return null
  const match = resolveEmojiShortcode(m[2])
  if (!match) return null
  const start = m.index + m[1].length
  const before = value.slice(0, start)
  const after = value.slice(caret)
  const next = before + match.native + ' ' + after
  return { value: next, caret: (before + match.native + ' ').length }
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
  // Draft text is stored per composer so each chat (and each thread) keeps its
  // own in-progress message instead of one input bleeding across chats.
  const draftKey = parentId ? `t:${parentId}` : `c:${channel.id}`
  const value = useStore((s) => s.drafts[draftKey] ?? '')
  const setDraftStore = useStore((s) => s.setDraft)
  const setValue = useCallback(
    (t: string) => setDraftStore(draftKey, t),
    [setDraftStore, draftKey],
  )

  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState<Pending[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const counterRef = useRef(0)
  const pendingRef = useRef<Pending[]>([])
  const lastTypingRef = useRef(0)
  const sendMessage = useStore((s) => s.sendMessage)
  const sendTyping = useStore((s) => s.sendTyping)
  const joinChannel = useStore((s) => s.joinChannel)
  const loadMembers = useStore((s) => s.loadMembers)
  const setReplyTarget = useStore((s) => s.setReplyTarget)
  const focusRequest = useStore((s) => s.focusRequest)
  // Quote-reply applies to the main channel composer only (not the thread composer).
  const activeReply = useStore((s) => (parentId ? null : s.replyTargets[channel.id] ?? null))

  // --- @ people / # resource / : emoji picker state ---
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [results, setResults] = useState<PickItem[]>([])
  const [sel, setSel] = useState(0)
  const caretRef = useRef(0)

  const canPost = channel.kind === 'dm' || channel.is_member

  // Ensure channel members are loaded so the @ picker can surface them first.
  useEffect(() => {
    if (!useStore.getState().members[channel.id]) loadMembers(channel.id)
  }, [channel.id, loadMembers])

  const autosize = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [])

  useEffect(() => {
    autosize()
  }, [value, autosize])

  // Focus the composer when the user picks a message to quote-reply to.
  useEffect(() => {
    if (activeReply) ref.current?.focus()
  }, [activeReply])

  // Honor an explicit focus request aimed at this composer (keyboard r / t).
  useEffect(() => {
    if (focusRequest?.key === draftKey) ref.current?.focus()
  }, [focusRequest, draftKey])

  // Populate the picker. People (@) resolve from the already-loaded directory
  // (channel members first); emoji (:) from the local shortcode index; resources
  // (#) hit the doc/canvas search.
  useEffect(() => {
    if (trigger === null) {
      setResults([])
      return
    }
    const q = trigger.query.trim()
    const ql = q.toLowerCase()

    // @ — people: synchronous, from the store. Members of this channel rank first.
    if (trigger.type === '@') {
      const st = useStore.getState()
      const memberIds = new Set((st.members[channel.id] ?? []).map((u) => u.id))
      const people = Object.values(st.users)
        .filter((u) => !ql || u.display_name.toLowerCase().includes(ql))
        .sort((a, b) => {
          const am = memberIds.has(a.id) ? 0 : 1
          const bm = memberIds.has(b.id) ? 0 : 1
          if (am !== bm) return am - bm
          return a.display_name.localeCompare(b.display_name)
        })
        .slice(0, 8)
        .map<PickItem>((u) => ({ kind: 'user', id: u.id, name: u.display_name }))
      setResults(people)
      setSel(0)
      return
    }

    // : — emoji shortcodes: synchronous, ranked local search.
    if (trigger.type === ':') {
      setResults(
        searchEmojis(q, 8).map((e) => ({
          kind: 'emoji' as const,
          id: e.id,
          name: e.name,
          native: e.native,
          shortcode: e.shortcode,
        })),
      )
      setSel(0)
      return
    }

    // # — resources: docs + canvases (debounced search; recents when empty).
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const toItem = (d: {
          id: string
          kind: 'doc' | 'canvas'
          title: string
          channel_name?: string
          channelName?: string
        }): PickItem => ({
          kind: d.kind === 'canvas' ? 'canvas' : 'doc',
          id: d.id,
          title: d.title || 'Untitled',
          channelName: d.channel_name ?? d.channelName,
        })
        if (q) {
          const res = await api.docSearch(q, 8)
          if (!cancelled) {
            setResults(res.results.map((d) => toItem({ ...d, title: d.title })))
            setSel(0)
          }
        } else {
          const st = useStore.getState()
          const chName: Record<string, string> = {}
          for (const c of st.channels)
            chName[c.id] = c.kind === 'dm' ? c.dm_user?.display_name ?? '' : c.name
          const recent = Object.values(st.docsByChannel)
            .flat()
            .filter((d) => !d.deleted_at)
            .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
            .slice(0, 8)
            .map((d) => toItem({ ...d, channelName: chName[d.channel_id] }))
          if (!cancelled) {
            setResults(recent)
            setSel(0)
          }
        }
      } catch {
        /* ignore */
      }
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trigger, channel.id])

  const pickerOpen = trigger !== null && results.length > 0

  function syncTrigger() {
    const el = ref.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    caretRef.current = caret
    const next = detectTrigger(el.value, caret)
    // Only replace the trigger when it actually changed — arrow-key navigation
    // fires keyup with the same trigger, and a fresh object would re-run the
    // results effect and reset the highlighted item back to the top.
    setTrigger((prev) => {
      if (prev === next) return prev
      if (
        prev &&
        next &&
        prev.type === next.type &&
        prev.start === next.start &&
        prev.query === next.query
      )
        return prev
      return next
    })
  }

  function pick(item: PickItem) {
    if (!trigger) return
    const before = value.slice(0, trigger.start)
    const after = value.slice(caretRef.current)
    let token: string
    switch (item.kind) {
      case 'user':
        token = `@${item.name} `
        break
      case 'emoji':
        token = `${item.native} `
        break
      case 'doc':
      case 'canvas':
        token = `[[${item.kind}:${item.id}|${item.title || 'Untitled'}]] `
        break
      default: {
        const _exhaustive: never = item
        void _exhaustive
        return
      }
    }
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

  // Keep a ref to the live pending list so the unmount cleanup revokes the
  // *current* preview URLs (a [] effect would capture a stale empty array).
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])
  useEffect(() => {
    return () => {
      pendingRef.current.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
    }
  }, [])

  const uploadOne = useCallback(
    (file: File) => {
      const id = String(++counterRef.current)
      const isImage = file.type.startsWith('image/')
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined
      setPending((p) => [
        ...p,
        { id, name: file.name, size: file.size, isImage, previewUrl, progress: 0 },
      ])
      api
        .uploadFile(channel.id, file, (frac) =>
          setPending((p) => p.map((x) => (x.id === id ? { ...x, progress: frac } : x))),
        )
        .then((att) =>
          setPending((p) =>
            p.map((x) => (x.id === id ? { ...x, progress: 1, attachment: att } : x)),
          ),
        )
        .catch((e) => {
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: true } : x)))
          if (e instanceof Error) toastError(e.message)
        })
    },
    [channel.id],
  )

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      Array.from(files).forEach((f) => uploadOne(f))
    },
    [uploadOne],
  )

  function removePending(id: string) {
    setPending((p) => {
      const target = p.find((x) => x.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return p.filter((x) => x.id !== id)
    })
  }

  const uploading = pending.some((p) => !p.attachment && !p.error)
  const readyIds = pending.filter((p) => p.attachment).map((p) => p.attachment!.id)

  async function doSend() {
    const content = value.trim()
    if (sending || uploading) return
    if (!content && readyIds.length === 0) return
    setSending(true)
    const prevValue = value
    const prevPending = pending
    setValue('')
    setTrigger(null)
    setPending([])
    try {
      await sendMessage(
        channel.id,
        content,
        parentId,
        readyIds.length ? readyIds : undefined,
        activeReply?.id,
      )
      if (activeReply) setReplyTarget(channel.id, null)
      // Sent — the staged previews are gone from the UI, so free their blob URLs.
      prevPending.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl))
    } catch {
      setValue(prevValue)
      setPending(prevPending) // restore on failure (URLs still needed)
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
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        if (results[sel]) pick(results[sel])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setTrigger(null)
        return
      }
    }
    if (e.key === 'Escape' && activeReply && !value) {
      e.preventDefault()
      setReplyTarget(channel.id, null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    let next = e.target.value
    let caret = e.target.selectionStart ?? next.length
    // Slack-style: typing `:fire:` expands immediately to 🔥.
    const expanded = expandClosedShortcode(next, caret)
    if (expanded) {
      next = expanded.value
      caret = expanded.caret
      setValue(next)
      caretRef.current = caret
      setTrigger(null)
      requestAnimationFrame(() => {
        const el = ref.current
        if (el) el.setSelectionRange(caret, caret)
      })
    } else {
      setValue(next)
      caretRef.current = caret
      setTrigger(detectTrigger(next, caret))
    }
    // throttle typing to 1 per 3s
    const now = Date.now()
    if (now - lastTypingRef.current > 3000) {
      lastTypingRef.current = now
      sendTyping(channel.id)
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (e.clipboardData.files && e.clipboardData.files.length > 0) {
      e.preventDefault()
      addFiles(e.clipboardData.files)
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

  const canSend = !sending && !uploading && (!!value.trim() || readyIds.length > 0)

  return (
    <div className="relative px-4 pb-4 pt-1">
      {pickerOpen && (
        <div className="absolute bottom-full left-4 right-4 z-20 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              {trigger?.type === '@'
                ? 'People'
                : trigger?.type === ':'
                  ? 'Emoji'
                  : 'Docs & canvases'}
            </span>
            <span className="text-[10px] text-[var(--color-text-faint)]">↑↓ · ↵/⇥ · esc</span>
          </div>
          {results.map((r, i) => (
            <button
              key={`${r.kind}-${r.id}`}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(r)
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                i === sel ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-panel-2)]'
              }`}
            >
              {r.kind === 'user' ? (
                <>
                  <Avatar id={r.id} name={r.name} size={22} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </>
              ) : r.kind === 'emoji' ? (
                <>
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-lg leading-none">
                    {r.native}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-text-dim)]">
                    :{r.shortcode}:
                  </span>
                  <span className="shrink-0 truncate text-[11px] text-[var(--color-text-faint)]">
                    {r.name}
                  </span>
                </>
              ) : (
                <>
                  <span>{r.kind === 'canvas' ? '🎨' : '📄'}</span>
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  {r.channelName && (
                    <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
                      #{r.channelName}
                    </span>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files)
        }}
        className={`rounded-xl border bg-[var(--color-panel)] px-3 py-2 transition ${
          dragOver
            ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
            : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]'
        }`}
      >
        {activeReply && (
          <div className="mb-2 flex items-stretch gap-2 rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-panel-2)] py-1.5 pl-2.5 pr-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold text-[var(--color-accent-hover)]">
                Replying to {activeReply.user.display_name}
              </div>
              <div className="truncate text-xs text-[var(--color-text-dim)]">
                {activeReply.deleted_at ? 'Deleted message' : activeReply.content || 'Attachment'}
              </div>
            </div>
            <button
              onClick={() => setReplyTarget(channel.id, null)}
              title="Cancel reply (Esc)"
              className="shrink-0 self-start rounded px-1 text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
            >
              ✕
            </button>
          </div>
        )}

        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((p) => (
              <div
                key={p.id}
                className="relative flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1.5 pr-2"
              >
                {p.isImage && p.previewUrl ? (
                  <img
                    src={p.previewUrl}
                    alt={p.name}
                    className="h-10 w-10 rounded object-cover"
                  />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded bg-[var(--color-panel)] text-lg">
                    📄
                  </span>
                )}
                <div className="min-w-0 max-w-[10rem]">
                  <div className="truncate text-xs text-[var(--color-text)]">{p.name}</div>
                  <div className="text-[10px] text-[var(--color-text-faint)]">
                    {p.error
                      ? 'failed'
                      : p.attachment
                        ? fmtBytes(p.size)
                        : `${Math.round(p.progress * 100)}%`}
                  </div>
                  {!p.attachment && !p.error && (
                    <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded bg-[var(--color-border)]">
                      <div
                        className="h-full bg-[var(--color-accent)]"
                        style={{ width: `${Math.max(5, p.progress * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  onClick={() => removePending(p.id)}
                  title="Remove"
                  className="ml-1 rounded px-1 text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            title="Attach files"
            className="mb-0.5 rounded-md px-2 py-1.5 text-lg leading-none text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            📎
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onKeyUp={syncTrigger}
            onClick={syncTrigger}
            onPaste={onPaste}
            placeholder={placeholder ?? 'Message'}
            className="max-h-[260px] flex-1 resize-none bg-transparent py-1.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
          />
          <button
            onClick={doSend}
            disabled={!canSend}
            title={uploading ? 'Waiting for uploads…' : 'Send (Enter)'}
            className="mb-0.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
