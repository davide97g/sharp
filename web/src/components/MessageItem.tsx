import { useEffect, useRef, useState } from 'react'
import type { Message, ReplyPreview } from '../lib/types'
import { useStore } from '../store'
import { Avatar } from './Avatar'
import { Markdown } from './Markdown'
import { AttachmentList } from './Attachments'
import { fmtTime } from '../lib/util'

export const REACTION_PALETTE = ['👍', '✅', '👀', '❤️', '😂', '🎉']

// Scroll to a quoted message (if it's currently loaded) and flash it.
function scrollToMessage(id: string) {
  const el = document.getElementById(`msg-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.animate(
    [{ backgroundColor: 'var(--color-accent-soft)' }, { backgroundColor: 'transparent' }],
    { duration: 1400, easing: 'ease-out' },
  )
}

// Uniform thin line icons for the hover toolbar — monochrome so the row of
// actions reads as one clean set (emoji rendered in mismatched colors/weights).
function Icon({ name }: { name: 'react' | 'reply' | 'thread' | 'edit' | 'trash' }) {
  const p = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'react':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="M8.5 14.5s1.3 1.7 3.5 1.7 3.5-1.7 3.5-1.7" />
          <path d="M9 9.5h.01M15 9.5h.01" />
        </svg>
      )
    case 'reply':
      return (
        <svg {...p}>
          <polyline points="9 16 4 11 9 6" />
          <path d="M4 11h9a6 6 0 0 1 6 6v1" />
        </svg>
      )
    case 'thread':
      return (
        <svg {...p}>
          <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5a8.4 8.4 0 0 1-.9-4A8.5 8.5 0 0 1 21 11.5Z" />
        </svg>
      )
    case 'edit':
      return (
        <svg {...p}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      )
    case 'trash':
      return (
        <svg {...p}>
          <path d="M4 7h16" />
          <path d="M10 11v6M14 11v6" />
          <path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
          <path d="M9 7V4h6v3" />
        </svg>
      )
  }
}

// The quoted-message chip rendered above a reply's own content.
function QuotedReply({ reply }: { reply: ReplyPreview }) {
  return (
    <button
      onClick={() => scrollToMessage(reply.id)}
      className="mb-1 flex w-full items-stretch gap-2 rounded-md border-l-2 border-[var(--color-accent)] bg-black/15 px-2 py-1 text-left transition hover:bg-black/25"
    >
      <div className="min-w-0">
        <div className="text-[11px] font-semibold text-[var(--color-accent-hover)]">
          {reply.user.display_name}
        </div>
        <div className="truncate text-xs text-[var(--color-text-dim)]">
          {reply.deleted ? 'Deleted message' : reply.content || 'Attachment'}
        </div>
      </div>
    </button>
  )
}

export function MessageItem({
  message,
  grouped,
  showThread = true,
  online,
  dm = false,
}: {
  message: Message
  grouped: boolean
  showThread?: boolean
  online?: boolean
  dm?: boolean
}) {
  const me = useStore((s) => s.me)
  const toggleReaction = useStore((s) => s.toggleReaction)
  const editMessage = useStore((s) => s.editMessage)
  const deleteMessage = useStore((s) => s.deleteMessage)
  const openThread = useStore((s) => s.openThread)
  const setReplyTarget = useStore((s) => s.setReplyTarget)
  const setActiveMessage = useStore((s) => s.setActiveMessage)
  const setPaletteFor = useStore((s) => s.setPaletteFor)

  // Palette open + "actioned" (keyboard/mouse target) come from the store so a
  // global shortcut handler can drive whichever message is hovered.
  const showPalette = useStore((s) => s.paletteForMessageId === message.id)
  const isReplyTarget = useStore((s) => s.replyTarget?.id === message.id)
  const isThreadTarget = useStore((s) => s.thread.open && s.thread.parentId === message.id)
  const actioned = showPalette || isReplyTarget || isThreadTarget

  const openPalette = () => setPaletteFor(showPalette ? null : message.id)
  const closePalette = () => setPaletteFor(null)

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

  // Editor (shared between layouts)
  const editor = (
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
  )

  // WhatsApp-style DM layout: my messages right, partner's left, chat bubbles.
  if (dm) {
    return (
      <div
        id={`msg-${message.id}`}
        className={`group relative flex px-4 ${grouped ? 'py-0.5' : 'pt-2 mt-1'} ${
          isMine ? 'justify-end' : 'justify-start'
        }`}
        onMouseEnter={() => setActiveMessage(message.id)}
        onMouseLeave={() => {
          setActiveMessage(null)
          if (showPalette) closePalette()
        }}
      >
        <div className={`relative flex max-w-[75%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
          {isDeleted ? (
            <div className="rounded-2xl bg-[var(--color-panel-2)] px-3 py-2 text-sm italic text-[var(--color-text-faint)]">
              This message was deleted.
            </div>
          ) : editing ? (
            <div className="w-full min-w-[16rem]">{editor}</div>
          ) : (
            <div
              className={`min-w-0 rounded-2xl px-3 py-2 ring-inset transition-[box-shadow] duration-200 ease-in-out ${
                actioned
                  ? 'ring-2 ring-[var(--color-accent)]'
                  : 'ring-0 ring-white/10 group-hover:ring-1'
              } ${
                isMine
                  ? 'rounded-br-sm bg-[var(--color-accent-soft)]'
                  : 'rounded-bl-sm bg-[var(--color-panel-2)]'
              }`}
            >
              {message.reply_to && <QuotedReply reply={message.reply_to} />}
              {message.content && <Markdown content={message.content} />}
              <span className="ml-2 mt-0.5 inline-block align-baseline text-[10px] text-[var(--color-text-faint)]">
                {message.edited_at && <span className="mr-1">(edited)</span>}
                {fmtTime(message.created_at)}
              </span>
            </div>
          )}

          {/* attachments */}
          {!isDeleted && !editing && message.attachments.length > 0 && (
            <AttachmentList attachments={message.attachments} />
          )}

          {/* reactions */}
          {!isDeleted && message.reactions.length > 0 && (
            <div className={`mt-1 flex flex-wrap gap-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
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

          {/* hover toolbar */}
          {!isDeleted && !editing && (
            <div
              className={`absolute -top-4 flex items-center gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/90 p-1 shadow-lg backdrop-blur-sm transition-opacity duration-150 ease-in-out ${
                actioned
                  ? 'pointer-events-auto opacity-100'
                  : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
              } ${isMine ? 'right-0' : 'left-0'}`}
            >
              <div className="relative">
                <ToolbarBtn title="Add reaction (E)" onClick={openPalette}>
                  <Icon name="react" />
                </ToolbarBtn>
                {showPalette && (
                  <div
                    className={`absolute top-10 z-20 flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1.5 shadow-lg ${
                      isMine ? 'right-0' : 'left-0'
                    }`}
                  >
                    {REACTION_PALETTE.map((e) => (
                      <button
                        key={e}
                        onClick={() => {
                          toggleReaction(message, e)
                          closePalette()
                        }}
                        className="rounded-md px-1.5 py-1 text-base transition-transform hover:scale-125 hover:bg-[var(--color-accent-soft)]"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ToolbarBtn title="Reply (R)" onClick={() => setReplyTarget(message)}>
                <Icon name="reply" />
              </ToolbarBtn>
              {isMine && (
                <ToolbarBtn title="Edit" onClick={() => setEditing(true)}>
                  <Icon name="edit" />
                </ToolbarBtn>
              )}
              {isMine &&
                (confirmDelete ? (
                  <div className="flex items-center gap-0.5 pl-0.5">
                    <button
                      onClick={doDelete}
                      className="rounded-md px-2 py-1 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/15"
                    >
                      Delete
                    </button>
                    <ToolbarBtn title="Cancel" onClick={() => setConfirmDelete(false)}>
                      <span className="text-xs leading-none">✕</span>
                    </ToolbarBtn>
                  </div>
                ) : (
                  <ToolbarBtn title="Delete" danger onClick={() => setConfirmDelete(true)}>
                    <Icon name="trash" />
                  </ToolbarBtn>
                ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={`group relative flex gap-3 px-4 transition-colors duration-200 ease-in-out ${
        actioned
          ? 'bg-[var(--color-accent-soft)]/25 ring-1 ring-inset ring-[var(--color-accent)]'
          : 'hover:bg-[var(--color-panel)]/50'
      } ${grouped ? 'py-0.5' : 'pt-2 pb-0.5 mt-1'}`}
      onMouseEnter={() => setActiveMessage(message.id)}
      onMouseLeave={() => {
        setActiveMessage(null)
        if (showPalette) closePalette()
      }}
    >
      {/* gutter: avatar or hover timestamp */}
      <div className="relative w-9 shrink-0">
        {grouped ? (
          // Absolute + nowrap so the hover timestamp never reflows the row height.
          <span className="absolute right-0 top-0.5 hidden whitespace-nowrap text-[10px] leading-5 tabular-nums text-[var(--color-text-faint)] group-hover:block">
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

        {!isDeleted && !editing && message.reply_to && (
          <div className="max-w-xl">
            <QuotedReply reply={message.reply_to} />
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
            {message.content && <Markdown content={message.content} />}
            {message.edited_at && (
              <span className="ml-1 align-baseline text-[10px] text-[var(--color-text-faint)]">
                (edited)
              </span>
            )}
          </div>
        )}

        {/* attachments */}
        {!isDeleted && !editing && message.attachments.length > 0 && (
          <AttachmentList attachments={message.attachments} />
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
        <div
          className={`absolute -top-4 right-2 flex items-center gap-0.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)]/90 p-1 shadow-lg backdrop-blur-sm transition-opacity duration-150 ease-in-out ${
            actioned
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
          }`}
        >
          <div className="relative">
            <ToolbarBtn title="Add reaction (E)" onClick={openPalette}>
              <Icon name="react" />
            </ToolbarBtn>
            {showPalette && (
              <div className="absolute right-0 top-10 z-20 flex gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel-2)] p-1.5 shadow-lg">
                {REACTION_PALETTE.map((e) => (
                  <button
                    key={e}
                    onClick={() => {
                      toggleReaction(message, e)
                      closePalette()
                    }}
                    className="rounded-md px-1.5 py-1 text-base transition-transform hover:scale-125 hover:bg-[var(--color-accent-soft)]"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ToolbarBtn title="Reply (R)" onClick={() => setReplyTarget(message)}>
            <Icon name="reply" />
          </ToolbarBtn>
          {showThread && (
            <ToolbarBtn title="Reply in thread (T)" onClick={() => openThread(message.id)}>
              <Icon name="thread" />
            </ToolbarBtn>
          )}
          {isMine && (
            <ToolbarBtn title="Edit" onClick={() => setEditing(true)}>
              <Icon name="edit" />
            </ToolbarBtn>
          )}
          {isMine &&
            (confirmDelete ? (
              <div className="flex items-center gap-0.5 pl-0.5">
                <button
                  onClick={doDelete}
                  className="rounded-md px-2 py-1 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/15"
                >
                  Delete
                </button>
                <ToolbarBtn title="Cancel" onClick={() => setConfirmDelete(false)}>
                  <span className="text-xs leading-none">✕</span>
                </ToolbarBtn>
              </div>
            ) : (
              <ToolbarBtn title="Delete" danger onClick={() => setConfirmDelete(true)}>
                <Icon name="trash" />
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
  danger,
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-panel)] ${
        danger ? 'hover:text-red-400' : 'hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
