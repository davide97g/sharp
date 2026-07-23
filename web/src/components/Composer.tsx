import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { resolveEmojiShortcode, searchEmojis } from '../lib/emoji'
import { buildGifToken, gifPreviewText } from '../lib/gif'
import { toastError } from '../lib/toast'
import { fmtBytes } from '../lib/util'
import { useCoarsePointer, useIsMobile } from '../lib/useMediaQuery'
import { Avatar } from './Avatar'
import { GifPicker, type GifPickerHandle } from './GifPicker'
import { DuckStreakBar } from './DuckStreakBar'
import { CreatePollModal } from './CreatePollModal'
import type { Attachment, Channel, GifResult } from '../lib/types'
import type { EncryptedAttachment } from '../lib/types'
import { encryptAttachmentFile, MAX_ENCRYPTED_FILE_BYTES } from '../lib/e2ee/attachments'
import {
  isRecordingSupported,
  MAX_RECORDING_MS,
  recordingFileName,
  VoiceRecorder,
} from '../lib/audioRecording'
import { VoiceRecorderBar } from './voice/VoiceRecorderBar'
import { VoicePreviewPlayer } from './AudioMessage'

type Pending = {
  id: string
  name: string
  size: number
  isImage: boolean
  isVoice?: boolean
  file?: File
  previewUrl?: string
  progress: number
  attachment?: Attachment
  encryptedMetadata?: EncryptedAttachment
  error?: boolean
}

// A completion candidate: person (@), resource (#), or emoji (:).
type PickItem =
  | { kind: 'user'; id: string; name: string }
  | { kind: 'all' } // @all — broadcast mention to everyone in the channel
  | { kind: 'doc' | 'canvas' | 'board'; id: string; title: string; channelName?: string }
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
  const encrypted = useStore((s) => s.isDmEncrypted(channel.id))
  const [pending, setPending] = useState<Pending[]>([])
  const [dragOver, setDragOver] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const gifPickerRef = useRef<GifPickerHandle>(null)
  const counterRef = useRef(0)
  const pendingRef = useRef<Pending[]>([])
  const lastTypingRef = useRef(0)
  const sendMessage = useStore((s) => s.sendMessage)
  const sendTyping = useStore((s) => s.sendTyping)
  const joinChannel = useStore((s) => s.joinChannel)
  const loadMembers = useStore((s) => s.loadMembers)
  const setReplyTarget = useStore((s) => s.setReplyTarget)
  const focusRequest = useStore((s) => s.focusRequest)
  const gifEnabled = useStore((s) => s.gifConfig)?.enabled ?? false
  // Quote-reply applies to the main channel composer only (not the thread composer).
  const activeReply = useStore((s) => (parentId ? null : s.replyTargets[channel.id] ?? null))
  const replyAuthorName = useStore((s) => {
    if (!activeReply) return null
    return (
      s.nicknames[activeReply.user.id]?.trim() || activeReply.user.display_name
    )
  })

  // --- @ people / # resource / : emoji picker state ---
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [results, setResults] = useState<PickItem[]>([])
  const [sel, setSel] = useState(0)
  const caretRef = useRef(0)
  const [manualGifOpen, setManualGifOpen] = useState(false)
  const [dismissedGifCommand, setDismissedGifCommand] = useState<string | null>(null)
  const [pollOpen, setPollOpen] = useState(false)
  const isGuest = useStore((s) => s.isGuest)
  const isMobile = useIsMobile()
  // Mobile "+" sheet holding attach / GIF / poll so the input row stays roomy.
  const [plusOpen, setPlusOpen] = useState(false)

  // --- voice message recording ---
  const [recorder, setRecorder] = useState<VoiceRecorder | null>(null)
  const [recordMs, setRecordMs] = useState(0)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const [recordingSupported] = useState(isRecordingSupported)

  const gifCommand = /^\/gif(?:\s+(.*))?$/.exec(value)
  const slashGifOpen = gifEnabled && gifCommand !== null && dismissedGifCommand !== value
  const gifOpen = gifEnabled && (manualGifOpen || slashGifOpen)
  const gifInitialQuery = slashGifOpen ? (gifCommand?.[1] ?? '') : ''

  const canPost =
    channel.kind === 'dm' || (channel.is_member && channel.my_role !== 'viewer')

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

  // Autofocus on mount and whenever the composer moves to a different chat
  // (channel switch or thread open) so the user can type immediately.
  // Touch devices skip this: focusing summons the keyboard over the messages
  // you just navigated to — there, typing starts with an explicit tap.
  const coarsePointer = useCoarsePointer()
  useEffect(() => {
    if (!coarsePointer) ref.current?.focus()
  }, [draftKey, coarsePointer])

  // Focus the composer when the user picks a message to quote-reply to.
  useEffect(() => {
    if (activeReply) ref.current?.focus()
  }, [activeReply])

  // Honor an explicit focus request aimed at this composer (keyboard r / t).
  useEffect(() => {
    if (focusRequest?.key === draftKey) ref.current?.focus()
  }, [focusRequest, draftKey])

  // Close the mobile "+" sheet when moving to a different chat or leaving mobile.
  useEffect(() => {
    setPlusOpen(false)
  }, [draftKey, isMobile])

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
      const label = (u: { id: string; display_name: string }) =>
        st.nicknames[u.id]?.trim() || u.display_name
      const people = Object.values(st.users)
        .filter((u) => {
          if (!ql) return true
          const nick = st.nicknames[u.id]?.toLowerCase() ?? ''
          return (
            u.display_name.toLowerCase().includes(ql) || nick.includes(ql)
          )
        })
        .sort((a, b) => {
          const am = memberIds.has(a.id) ? 0 : 1
          const bm = memberIds.has(b.id) ? 0 : 1
          if (am !== bm) return am - bm
          return label(a).localeCompare(label(b))
        })
        .slice(0, 8)
        .map<PickItem>((u) => ({ kind: 'user', id: u.id, name: label(u) }))
      // `@all` (notify everyone) ranks after matching people, and stays offered
      // even when fully typed — it only leaves once picked (Tab/Enter/click).
      if (channel.kind !== 'dm' && 'all'.startsWith(ql)) {
        people.push({ kind: 'all' })
      }
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
          kind: 'doc' | 'canvas' | 'board'
          title: string
          channel_name?: string
          channelName?: string
        }): PickItem => ({
          kind: d.kind,
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
            chName[c.id] =
              c.kind === 'dm'
                ? (c.dm_user?.id && st.nicknames[c.dm_user.id]?.trim()) ||
                  c.dm_user?.display_name ||
                  ''
                : c.name
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
    if (/^\/gif(?:\s+(.*))?$/.test(el.value)) {
      setTrigger(null)
      return
    }
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
      case 'all':
        token = '@all '
        break
      case 'emoji':
        token = `${item.native} `
        break
      case 'doc':
      case 'canvas':
      case 'board':
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
    (file: File, opts?: { voice?: boolean }) => {
      if (encrypted && file.size > MAX_ENCRYPTED_FILE_BYTES) {
        toastError('Encrypted attachments are limited to 50 MB because encryption happens in memory.')
        return
      }
      const id = String(++counterRef.current)
      const isImage = file.type.startsWith('image/')
      const isVoice = opts?.voice ?? false
      const previewUrl = isImage ? URL.createObjectURL(file) : undefined
      setPending((p) => [
        ...p,
        { id, name: file.name, size: file.size, isImage, isVoice, file: isVoice ? file : undefined, previewUrl, progress: 0 },
      ])
      void (async () => {
        const prepared = encrypted ? await encryptAttachmentFile(file) : null
        return api.uploadFile(channel.id, prepared?.file ?? file, (frac) =>
          setPending((p) => p.map((x) => (x.id === id ? { ...x, progress: frac } : x))),
          encrypted,
        ).then((attachment) => ({ attachment, prepared }))
      })()
        .then(({ attachment, prepared }) =>
          setPending((p) =>
            p.map((x) =>
              x.id === id
                ? {
                    ...x,
                    progress: 1,
                    attachment,
                    encryptedMetadata: prepared
                      ? { id: attachment.id, ...prepared.metadata }
                      : undefined,
                  }
                : x,
            ),
          ),
        )
        .catch((e) => {
          setPending((p) => p.map((x) => (x.id === id ? { ...x, error: true } : x)))
          if (e instanceof Error) toastError(e.message)
        })
    },
    [channel.id, encrypted],
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

  async function startRecording() {
    if (recorderRef.current) return
    const rec = new VoiceRecorder()
    recorderRef.current = rec
    try {
      await rec.start()
    } catch {
      recorderRef.current = null
      rec.cancel()
      toastError('Could not access the microphone.')
      return
    }
    if (recorderRef.current !== rec) {
      // Cancelled while permission was pending.
      rec.cancel()
      return
    }
    setRecordMs(0)
    setRecorder(rec)
  }

  async function stopRecording() {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    setRecorder(null)
    const durationSec = rec.elapsedMs() / 1000
    const blob = await rec.stop()
    if (!blob || blob.size === 0) return
    const file = new File([blob], recordingFileName(rec.mimeType, durationSec), {
      type: rec.mimeType,
    })
    uploadOne(file, { voice: true })
  }

  function cancelRecording() {
    const rec = recorderRef.current
    recorderRef.current = null
    setRecorder(null)
    rec?.cancel()
  }

  // Drive the elapsed timer and enforce the hard duration cap.
  useEffect(() => {
    if (!recorder) return
    const timer = setInterval(() => {
      const ms = recorder.elapsedMs()
      setRecordMs(ms)
      if (ms >= MAX_RECORDING_MS) void stopRecording()
    }, 200)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder])

  // Release the mic if the composer unmounts or switches chats mid-recording.
  useEffect(() => {
    return () => {
      recorderRef.current?.cancel()
      recorderRef.current = null
      setRecorder(null)
    }
  }, [draftKey])

  const uploading = pending.some((p) => !p.attachment && !p.error)
  const readyIds = pending.filter((p) => p.attachment).map((p) => p.attachment!.id)
  const encryptedAttachments = pending
    .map((p) => p.encryptedMetadata)
    .filter((item): item is EncryptedAttachment => !!item)

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
        encryptedAttachments.length ? encryptedAttachments : undefined,
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

  async function sendGif(g: GifResult) {
    if (sending) return
    const wasCommand = gifCommand !== null
    const previousValue = value
    setSending(true)
    setManualGifOpen(false)
    if (wasCommand) setValue('')
    setDismissedGifCommand(wasCommand ? previousValue : null)
    setTrigger(null)
    try {
      await sendMessage(channel.id, buildGifToken(g), parentId, undefined, activeReply?.id)
      if (activeReply) setReplyTarget(channel.id, null)
    } catch {
      if (wasCommand) setValue(previousValue)
    } finally {
      setSending(false)
      requestAnimationFrame(() => ref.current?.focus())
    }
  }

  function closeGifPicker() {
    setManualGifOpen(false)
    if (gifCommand) setDismissedGifCommand(value)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (gifOpen && e.key === 'Tab') {
      e.preventDefault()
      gifPickerRef.current?.move(e.shiftKey ? -1 : 1)
      return
    }
    if (gifOpen && e.key === 'Enter' && !e.shiftKey) {
      if (gifPickerRef.current?.pickSelected()) {
        e.preventDefault()
        return
      }
      if (slashGifOpen) {
        e.preventDefault()
        return
      }
    }
    if (gifOpen && e.key === 'Escape') {
      e.preventDefault()
      closeGifPicker()
      return
    }
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
      setTrigger(/^\/gif(?:\s+(.*))?$/.test(next) ? null : detectTrigger(next, caret))
    }
    setDismissedGifCommand(null)
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

  if (channel.kind !== 'dm' && channel.is_member && channel.my_role === 'viewer') {
    return (
      <div className="border-t border-[var(--color-border)] px-4 py-3">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3 text-sm text-[var(--color-text-dim)]">
          You have view-only access to this channel
        </div>
      </div>
    )
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
    <div className="composer-wrap relative px-4 pb-3 pt-1 md:pb-4" data-has-draft={!!value || undefined}>
      {gifOpen && (
        <div className="composer-picker absolute bottom-full left-4 z-30 mb-2">
          <GifPicker
            ref={gifPickerRef}
            key={slashGifOpen ? `slash:${gifInitialQuery}` : 'manual'}
            initialQuery={gifInitialQuery}
            onPick={(g) => void sendGif(g)}
            onClose={closeGifPicker}
            autoFocus={!slashGifOpen}
          />
        </div>
      )}
      {pickerOpen && !gifOpen && (
        <div className="composer-picker absolute bottom-full left-4 right-4 z-20 mb-1 max-h-64 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
              {trigger?.type === '@'
                ? 'People'
                : trigger?.type === ':'
                  ? 'Emoji'
                  : 'Docs, canvases & boards'}
            </span>
            <span className="text-[10px] text-[var(--color-text-faint)]">↑↓ · ↵/⇥ · esc</span>
          </div>
          {results.map((r, i) => (
            <button
              key={r.kind === 'all' ? 'all' : `${r.kind}-${r.id}`}
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
              ) : r.kind === 'all' ? (
                <>
                  <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] text-xs">
                    📣
                  </span>
                  <span className="min-w-0 shrink-0 font-medium">all</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-faint)]">
                    Notify everyone in this channel
                  </span>
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
                  <span>{r.kind === 'canvas' ? '🎨' : r.kind === 'board' ? '🗂️' : '📄'}</span>
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
        className={`composer-shell relative rounded-xl border bg-[var(--color-panel)] px-3 py-2 transition ${
          dragOver
            ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
            : 'border-[var(--color-border)] focus-within:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent-soft)]'
        }`}
      >
        {!parentId ? <DuckStreakBar channelId={channel.id} /> : null}
        {activeReply && (
          <div className="mb-2 flex items-stretch gap-2 rounded-lg border-l-2 border-[var(--color-accent)] bg-[var(--color-panel-2)] py-1.5 pl-2.5 pr-2">
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold text-[var(--color-accent-hover)]">
                Replying to {replyAuthorName}
              </div>
              <div className="truncate text-xs text-[var(--color-text-dim)]">
                {activeReply.deleted_at
                  ? 'Deleted message'
                  : activeReply.encrypted
                    ? typeof activeReply.decryptedText === 'string'
                      ? gifPreviewText(activeReply.decryptedText) || 'Attachment'
                      : '🔒 Encrypted message'
                    : gifPreviewText(activeReply.content) || 'Attachment'}
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
            {pending.map((p) =>
              p.isVoice && p.file ? (
                <div key={p.id} className="relative flex items-center gap-1">
                  <VoicePreviewPlayer file={p.file} />
                  {!p.attachment && !p.error && (
                    <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden rounded bg-[var(--color-border)]">
                      <div
                        className="h-full bg-[var(--color-accent)]"
                        style={{ width: `${Math.max(5, p.progress * 100)}%` }}
                      />
                    </div>
                  )}
                  {p.error && (
                    <span className="text-[10px] text-red-500">failed</span>
                  )}
                  <button
                    onClick={() => removePending(p.id)}
                    title="Remove"
                    aria-label="Remove voice message"
                    className="rounded px-1 text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
                  >
                    ✕
                  </button>
                </div>
              ) : (
              <div
                key={p.id}
                className="composer-attachment relative flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1.5 pr-2"
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

        {recorder ? (
          <VoiceRecorderBar
            recorder={recorder}
            elapsedMs={recordMs}
            onStop={() => void stopRecording()}
            onCancel={cancelRecording}
          />
        ) : (
        <div className="flex items-end gap-1.5 md:gap-2">
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

          {/* Mobile: one "+" that opens a sheet with attach / GIF / poll, so the
              text field keeps the full width. Desktop keeps the inline buttons. */}
          {isMobile ? (
            (() => {
              const canPoll = channel.kind !== 'dm' && !isGuest && canPost
              return (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setTrigger(null)
                      setPlusOpen((open) => !open)
                    }}
                    aria-label="Add attachment, GIF, or poll"
                    aria-expanded={plusOpen}
                    className={`mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                      plusOpen
                        ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                        : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]'
                    }`}
                  >
                    <PlusIcon open={plusOpen} />
                  </button>
                  {plusOpen && (
                    <>
                      <button
                        type="button"
                        aria-hidden
                        tabIndex={-1}
                        onClick={() => setPlusOpen(false)}
                        className="fixed inset-0 z-30 cursor-default"
                      />
                      <div
                        role="menu"
                        className="absolute bottom-full left-0 z-40 mb-2 min-w-44 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl"
                      >
                        <PlusItem
                          icon={<PaperclipGlyph />}
                          label="Photo or file"
                          onClick={() => {
                            setPlusOpen(false)
                            fileRef.current?.click()
                          }}
                        />
                        {gifEnabled && (
                          <PlusItem
                            icon={<span className="text-xs font-bold leading-none">GIF</span>}
                            label="GIF"
                            onClick={() => {
                              setPlusOpen(false)
                              setTrigger(null)
                              setManualGifOpen(true)
                            }}
                          />
                        )}
                        {canPoll && (
                          <PlusItem
                            icon={<PollIcon />}
                            label="Poll"
                            onClick={() => {
                              setPlusOpen(false)
                              setPollOpen(true)
                            }}
                          />
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })()
          ) : (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                title="Attach files"
                aria-label="Attach files"
                className="mb-0.5 flex items-center justify-center rounded-md px-2 py-1.5 text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              >
                <PaperclipGlyph />
              </button>
              {gifEnabled && (
                <button
                  type="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={() => {
                    setTrigger(null)
                    setManualGifOpen((open) => !open)
                  }}
                  title="Send a GIF"
                  className="mb-0.5 flex items-center justify-center rounded-md px-2 py-1.5 text-xs font-bold leading-none text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
                >
                  GIF
                </button>
              )}
              {channel.kind !== 'dm' && !isGuest && canPost ? (
                <button
                  type="button"
                  onClick={() => setPollOpen(true)}
                  title="Create a poll"
                  aria-label="Create a poll"
                  className="mb-0.5 flex items-center justify-center rounded-md px-2 py-1.5 text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <PollIcon />
                </button>
              ) : null}
              {recordingSupported && (
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  title="Record a voice message"
                  aria-label="Record a voice message"
                  className="mb-0.5 flex items-center justify-center rounded-md px-2 py-1.5 text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  <MicGlyph />
                </button>
              )}
            </>
          )}

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
            className="composer-textarea min-h-11 max-h-[260px] flex-1 resize-none bg-transparent py-2.5 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none md:min-h-0 md:py-1.5 md:text-sm"
          />

          {/* Mobile: an icon that flips between voice-record (empty) and send —
              the WhatsApp affordance. Desktop keeps the labelled Send button. */}
          {isMobile ? (
            !canSend && recordingSupported && !value.trim() && readyIds.length === 0 ? (
              <button
                type="button"
                onClick={() => void startRecording()}
                aria-label="Record a voice message"
                className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--color-text-faint)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <MicGlyph />
              </button>
            ) : (
              <button
                onClick={doSend}
                disabled={!canSend}
                aria-label="Send message"
                title={uploading ? 'Waiting for uploads…' : 'Send'}
                className="composer-send mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)] text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <SendIcon />
              </button>
            )
          ) : (
            <button
              onClick={doSend}
              disabled={!canSend}
              title={uploading ? 'Waiting for uploads…' : 'Send (Enter)'}
              className="composer-send mb-0.5 min-h-11 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] disabled:opacity-40 md:min-h-0"
            >
              Send
            </button>
          )}
        </div>
        )}
      </div>
      {pollOpen ? (
        <CreatePollModal mode="channel" channelId={channel.id} onClose={() => setPollOpen(false)} />
      ) : null}
    </div>
  )
}

function PollIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  )
}

function MicGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
    </svg>
  )
}

function PaperclipGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.4 11.05 12.2 20.3a5 5 0 0 1-7.07-7.07l9.19-9.19a3.33 3.33 0 1 1 4.71 4.71l-9.2 9.2a1.67 1.67 0 0 1-2.36-2.36l8.49-8.49" />
    </svg>
  )
}

// Rotates from a plus into a close (×) while the sheet is open.
function PlusIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="transition-transform duration-200"
      style={{ transform: open ? 'rotate(45deg)' : 'none' }}
      aria-hidden
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M3.4 20.4 21 12 3.4 3.6 3.39 10.2 15 12l-11.61 1.8z" />
    </svg>
  )
}

function PlusItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-panel-2)] active:bg-[var(--color-panel-2)]"
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--color-text-dim)]">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  )
}
