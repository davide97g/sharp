import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { toastError } from '../lib/toast'
import { fmtBytes } from '../lib/util'
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
    setPending([])
    try {
      await sendMessage(channel.id, content, parentId, readyIds.length ? readyIds : undefined)
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
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
    <div className="px-4 pb-4 pt-1">
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
