import { useEffect, useRef, useState } from 'react'
import type { Message } from '../lib/types'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { Markdown } from './Markdown'
import { fmtTime } from '../lib/util'

export const REACTION_PALETTE = ['👍', '✅', '👀', '❤️', '😂', '🎉']

export function MessageItem({
  message,
  grouped,
  showThread = true,
  online,
}: {
  message: Message
  grouped: boolean
  showThread?: boolean
  online?: boolean
}) {
  const me = useStore((s) => s.me)
  const toggleReaction = useStore((s) => s.toggleReaction)
  const editMessage = useStore((s) => s.editMessage)
  const deleteMessage = useStore((s) => s.deleteMessage)
  const openThread = useStore((s) => s.openThread)

  const [showPalette, setShowPalette] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const editRef = useRef<HTMLTextAreaElement>(null)

  const isMine = me?.id === message.user.id
  const isDeleted = !!message.deleted_at

  useEffect(() => {
    if (editing) {
      setDraft(message.content)
      requestAnimationFrame(() => {
        const el = editRef.current
        if (el) {
          el.focus()
          el.setSelectionRange(el.value.length, el.value.length)
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  async function saveEdit() {
    const content = draft.trim()
    if (!content || content === message.content) {
      setEditing(false)
      return
    }
    try {
      await editMessage(message.id, content)
      setEditing(false)
    } catch {
      /* toast handled in store */
    }
  }

  async function doDelete() {
    try {
      await deleteMessage(message.id)
    } catch {
      /* toast handled */
    }
    setConfirmDelete(false)
  }

  return (
    <div
      className={`group relative flex gap-3 px-4 hover:bg-[var(--color-panel)]/40 ${
        grouped ? 'py-0.5' : 'pt-2 pb-0.5 mt-1'
      }`}
      onMouseLeave={() => setShowPalette(false)}
    >
      {/* gutter: avatar or hover timestamp */}
      <div className="w-9 shrink-0">
        {grouped ? (
          <span className="mt-0.5 hidden text-[10px] leading-5 text-[var(--color-text-faint)] group-hover:block">
            {fmtTime(message.created_at)}
          </span>
        ) : (
          <Avatar id={message.user.id} name={message.user.display_name} size={36} online={online} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-[var(--color-text)]">
              {message.user.display_name}
            </span>
            <span className="text-[11px] text-[var(--color-text-faint)]">
              {fmtTime(message.created_at)}
            </span>
          </div>
        )}

        {isDeleted ? (
          <p className="text-sm italic text-[var(--color-text-faint)]">
            This message was deleted.
          </p>
        ) : editing ? (
          <div className="my-1 rounded-lg border border-[var(--color-accent)] bg-[var(--color-panel)] px-3 py-2 ring-2 ring-[var(--color-accent-soft)]">
            <textarea
              ref={editRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value)
                const el = e.target
                el.style.height = 'auto'
                el.style.height = el.scrollHeight + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  saveEdit()
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
              }}
              className="max-h-64 w-full resize-none bg-transparent text-sm text-[var(--color-text)] focus:outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={saveEdit}
                className="rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-white hover:bg-[var(--color-accent-hover)]"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
              >
                Cancel
              </button>
              <span className="text-[11px] text-[var(--color-text-faint)]">
                Enter to save · Esc to cancel
              </span>
            </div>
          </div>
        ) : (
          <div className="pr-8">
            <Markdown content={message.content} />
            {message.edited_at && (
              <span className="ml-1 align-baseline text-[10px] text-[var(--color-text-faint)]">
                (edited)
              </span>
            )}
          </div>
        )}

        {/* reactions */}
        {!isDeleted && message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => toggleReaction(message, r.emoji)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                  r.me
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                    : 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-dim)] hover:border-[var(--color-text-faint)]'
                }`}
              >
                <span>{r.emoji}</span>
                <span className="tabular-nums">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* reply-count pill (top-level only) */}
        {!isDeleted && showThread && message.reply_count > 0 && (
          <button
            onClick={() => openThread(message.id)}
            className="mt-1 flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--color-accent-hover)] hover:bg-[var(--color-accent-soft)]"
          >
            <span>
              {message.reply_count} {message.reply_count === 1 ? 'reply' : 'replies'}
            </span>
            {message.last_reply_at && (
              <span className="font-normal text-[var(--color-text-faint)]">
                · last {fmtTime(message.last_reply_at)}
              </span>
            )}
          </button>
        )}
      </div>

      {/* hover toolbar */}
      {!isDeleted && !editing && (
        <div className="absolute -top-3 right-3 hidden items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] shadow-md group-hover:flex">
          <div className="relative">
            <ToolbarBtn title="Add reaction" onClick={() => setShowPalette((v) => !v)}>
              😊
            </ToolbarBtn>
            {showPalette && (
              <div className="absolute right-0 top-9 z-20 flex gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1.5 shadow-lg">
                {REACTION_PALETTE.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      toggleReaction(message, e)
                      setShowPalette(false)
                    }}
                    className="rounded-md px-1.5 py-1 text-base hover:bg-[var(--color-accent-soft)]"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          {showThread && (
            <ToolbarBtn title="Reply in thread" onClick={() => openThread(message.id)}>
              💬
            </ToolbarBtn>
          )}
          {isMine && (
            <ToolbarBtn title="Edit" onClick={() => setEditing(true)}>
              ✏️
            </ToolbarBtn>
          )}
          {isMine &&
            (confirmDelete ? (
              <div className="flex items-center gap-1 px-1">
                <button
                  onClick={doDelete}
                  className="rounded px-1.5 py-0.5 text-xs font-semibold text-red-300 hover:bg-red-500/20"
                >
                  Delete?
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="rounded px-1 py-0.5 text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel)]"
                >
                  ✕
                </button>
              </div>
            ) : (
              <ToolbarBtn title="Delete" onClick={() => setConfirmDelete(true)}>
                🗑️
              </ToolbarBtn>
            ))}
        </div>
      )}
    </div>
  )
}

function ToolbarBtn({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="px-2 py-1.5 text-sm leading-none hover:bg-[var(--color-panel)]"
    >
      {children}
    </button>
  )
}
