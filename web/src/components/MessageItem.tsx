import { useEffect, useRef, useState } from 'react'
import type { Message, ReplyPreview } from '../lib/types'
import { useStore } from '../store'
import { useCoarsePointer } from '../lib/useMediaQuery'
import { Avatar } from './Avatar'
import { UserChip } from './UserCard'
import { Markdown } from './Markdown'
import { AttachmentList } from './Attachments'
import { fmtTime } from '../lib/util'
import { useDisplayName } from '../lib/displayName'
import { gifPreviewText } from '../lib/gif'
import { LockIcon } from './icons'
import { Button } from '../ui'
import { CreateTaskFromMessage } from './tasks/CreateTaskFromMessage'

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
function Icon({ name }: { name: 'react' | 'reply' | 'thread' | 'edit' | 'trash' | 'task' }) {
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
    case 'task':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
          <path d="m8.5 12 2.5 2.5 5-5.5" />
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

function QuotedAuthorName({
  userId,
  fallback,
}: {
  userId: string
  fallback: string
}) {
  const name = useDisplayName(userId, fallback)
  return (
    <div className="text-2xs font-semibold text-[var(--color-accent-hover)]">{name}</div>
  )
}

// The quoted-message chip rendered above a reply's own content.
function QuotedReply({ reply }: { reply: ReplyPreview }) {
  const decryptedText = useStore((state) => {
    if (!reply.encrypted) return undefined
    for (const channel of Object.values(state.byChannel)) {
      const message = channel.list.find((item) => item.id === reply.id)
      if (message) return message.decryptedText
    }
    if (state.thread.parent?.id === reply.id) return state.thread.parent.decryptedText
    return state.thread.replies.find((item) => item.id === reply.id)?.decryptedText
  })
  const preview = reply.deleted
    ? 'Deleted message'
    : reply.encrypted
      ? typeof decryptedText === 'string'
        ? gifPreviewText(decryptedText) || 'Attachment'
        : '🔒 Encrypted message'
      : gifPreviewText(reply.content) || 'Attachment'
  return (
    <button
      onClick={() => scrollToMessage(reply.id)}
      className="mb-1 flex w-full items-stretch gap-2 rounded-md border-l-2 border-[var(--color-accent)] bg-black/15 px-2 py-1 text-left transition hover:bg-black/25"
    >
      <div className="min-w-0">
        <QuotedAuthorName userId={reply.user.id} fallback={reply.user.display_name} />
        <div className="truncate text-xs text-[var(--color-text-dim)]">
          {preview}
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
  const coarsePointer = useCoarsePointer()
  const authorName = useDisplayName(message.user.id, message.user.display_name)

  // Palette open + "actioned" (keyboard/mouse target) come from the store so a
  // global shortcut handler can drive whichever message is hovered.
  // On touch, tapping a message pins it as active so the toolbar can appear.
  const showPalette = useStore((s) => s.paletteForMessageId === message.id)
  const isReplyTarget = useStore((s) => s.replyTargets[message.channel_id]?.id === message.id)
  const isThreadTarget = useStore((s) => s.thread.open && s.thread.parentId === message.id)
  const isActive = useStore((s) => s.activeMessageId === message.id)
  const actioned = showPalette || isReplyTarget || isThreadTarget || (coarsePointer && isActive)

  // Landed here from search: sustained highlight + word highlight until the user acts.
  const isFocused = useStore(
    (s) => s.focus?.messageId === message.id && s.focus?.channelId === message.channel_id,
  )
  const focusQuery = useStore((s) =>
    s.focus?.messageId === message.id ? s.focus.query : undefined,
  )

  const openPalette = () => setPaletteFor(showPalette ? null : message.id)
  const closePalette = () => setPaletteFor(null)

  function onMessagePointerEnter() {
    if (!coarsePointer) setActiveMessage(message.id)
  }

  function onMessagePointerLeave() {
    if (coarsePointer) return
    setActiveMessage(null)
    if (showPalette) closePalette()
  }

  function onMessageTap(e: React.MouseEvent) {
    if (!coarsePointer) return
    // Don't steal taps from buttons / links inside the message.
    if ((e.target as HTMLElement).closest('button, a, input, textarea')) return
    setActiveMessage(isActive ? null : message.id)
  }

  // Clear tap-selected toolbar when tapping elsewhere.
  useEffect(() => {
    if (!coarsePointer || !isActive) return
    function onDocPointerDown(ev: PointerEvent) {
      const el = document.getElementById(`msg-${message.id}`)
      if (el && !el.contains(ev.target as Node)) {
        setActiveMessage(null)
        if (showPalette) closePalette()
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  }, [coarsePointer, isActive, message.id, setActiveMessage, showPalette])

  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [taskModal, setTaskModal] = useState(false)
  const displayContent = message.encrypted ? message.decryptedText : message.content
  const [draft, setDraft] = useState(typeof displayContent === 'string' ? displayContent : '')
  const [freshOnMount] = useState(() => Date.now() - Date.parse(message.created_at) < 8000)
  const [reactionBurst, setReactionBurst] = useState<{ emoji: string; id: number } | null>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)
  const reactionBurstTimer = useRef<number | null>(null)
  const reactionBurstId = useRef(0)

  const isMine = me?.id === message.user.id
  const isDeleted = !!message.deleted_at
  const canEdit = isMine && (!message.encrypted || typeof message.decryptedText === 'string')
  // A task can be created from any readable message (encrypted needs plaintext).
  const canTask = !message.encrypted || typeof message.decryptedText === 'string'
  const taskModalEl = taskModal ? (
    <CreateTaskFromMessage message={message} onClose={() => setTaskModal(false)} />
  ) : null

  useEffect(() => {
    if (editing) {
      setDraft(typeof displayContent === 'string' ? displayContent : '')
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

  useEffect(
    () => () => {
      if (reactionBurstTimer.current !== null) window.clearTimeout(reactionBurstTimer.current)
    },
    [],
  )

  function react(emoji: string, target?: HTMLElement) {
    if (target && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      target.getAnimations().forEach((animation) => animation.cancel())
      target.animate(
        [
          { transform: 'scale(1) rotate(0deg)' },
          { transform: 'scale(1.3) rotate(-5deg)', offset: 0.38 },
          { transform: 'scale(0.94) rotate(2deg)', offset: 0.72 },
          { transform: 'scale(1) rotate(0deg)' },
        ],
        { duration: 460, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
      )
    }
    const id = ++reactionBurstId.current
    setReactionBurst({ emoji, id })
    if (reactionBurstTimer.current !== null) window.clearTimeout(reactionBurstTimer.current)
    reactionBurstTimer.current = window.setTimeout(() => setReactionBurst(null), 720)
    void toggleReaction(message, emoji)
  }

  const burst = reactionBurst && (
    <span
      key={reactionBurst.id}
      className="reaction-burst pointer-events-none absolute z-30"
      data-side={isMine ? 'mine' : 'other'}
      aria-hidden
    >
      <i />
      <i />
      <i />
      <i />
      <b>{reactionBurst.emoji}</b>
    </span>
  )

  async function saveEdit() {
    const content = draft.trim()
    if (!content || content === displayContent) {
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
        <Button size="xs" onClick={saveEdit}>
          Save
        </Button>
        <Button variant="outline" size="xs" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <span className="text-2xs text-[var(--color-text-faint)]">
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
        className={`group relative flex px-4 ${freshOnMount ? 'message-arrival' : ''} ${grouped ? 'py-0.5' : 'pt-2 mt-1'} ${
          isMine ? 'justify-end' : 'justify-start'
        }`}
        data-message-mine={isMine || undefined}
        onMouseEnter={onMessagePointerEnter}
        onMouseLeave={onMessagePointerLeave}
        onClick={onMessageTap}
      >
        {burst}
        <div className={`relative flex max-w-[75%] flex-col ${isMine ? 'items-end' : 'items-start'}`}>
          {isDeleted ? (
            <div className="rounded-2xl bg-[var(--color-panel-2)] px-3 py-2 text-sm italic text-[var(--color-text-faint)]">
              This message was deleted.
            </div>
          ) : editing ? (
            <div className="w-full min-w-[16rem]">{editor}</div>
          ) : (
            <div
              className={`chat-bubble min-w-0 rounded-2xl px-3 py-2 ring-inset transition-[box-shadow] duration-200 ease-in-out ${
                actioned || isFocused
                  ? 'ring-2 ring-[var(--color-accent)]'
                  : 'ring-0 ring-white/10 group-hover:ring-1'
              } ${
                isMine
                  ? 'rounded-br-sm bg-[var(--color-accent-soft)]'
                  : 'rounded-bl-sm bg-[var(--color-panel-2)]'
              }`}
            >
              {message.reply_to && <QuotedReply reply={message.reply_to} />}
              <RenderedMessageContent message={message} highlight={focusQuery} />
              <span className="ml-2 mt-0.5 inline-block align-baseline text-3xs text-[var(--color-text-faint)]">
                {message.edited_at && <span className="mr-1">(edited)</span>}
                {message.encrypted && (
                  <span className="mr-1 inline-flex align-[-1px]" title="End-to-end encrypted">
                    <LockIcon size={9} />
                  </span>
                )}
                {fmtTime(message.created_at)}
              </span>
            </div>
          )}

          {/* attachments */}
          {!isDeleted && !editing && message.attachments.length > 0 &&
            (!message.encrypted || typeof message.decryptedText === 'string') && (
            <AttachmentList attachments={message.attachments} />
          )}

          {/* reactions */}
          {!isDeleted && message.reactions.length > 0 && (
            <div className={`mt-1 flex flex-wrap gap-1 ${isMine ? 'justify-end' : 'justify-start'}`}>
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  onClick={(event) => react(r.emoji, event.currentTarget)}
                  className={`reaction-chip flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                    r.me
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                      : 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-dim)] hover:border-[var(--color-text-faint)]'
                  }`}
                >
                  <span className="reaction-emoji">{r.emoji}</span>
                  <span className="reaction-count tabular-nums">{r.count}</span>
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
                          react(e)
                          closePalette()
                        }}
                        className="reaction-palette-item rounded-md px-1.5 py-1 text-base hover:bg-[var(--color-accent-soft)]"
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ToolbarBtn title="Reply (R)" onClick={() => setReplyTarget(message.channel_id, message)}>
                <Icon name="reply" />
              </ToolbarBtn>
              {canTask && (
                <ToolbarBtn title="Create task" onClick={() => setTaskModal(true)}>
                  <Icon name="task" />
                </ToolbarBtn>
              )}
              {canEdit && (
                <ToolbarBtn title="Edit" onClick={() => setEditing(true)}>
                  <Icon name="edit" />
                </ToolbarBtn>
              )}
              {isMine &&
                (confirmDelete ? (
                  <div className="flex items-center gap-0.5 pl-0.5">
                    <Button variant="danger" size="xs" onClick={doDelete}>
                      Delete
                    </Button>
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
        {taskModalEl}
      </div>
    )
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={`group relative flex gap-3 px-4 transition-colors duration-200 ease-in-out ${freshOnMount ? 'message-arrival' : ''} ${
        isFocused
          ? 'bg-[var(--color-accent-soft)]/40 ring-2 ring-inset ring-[var(--color-accent)]'
          : actioned
            ? 'bg-[var(--color-accent-soft)]/25 ring-1 ring-inset ring-[var(--color-accent)]'
            : 'hover:bg-[var(--color-panel)]/50'
      } ${grouped ? 'py-0.5' : 'pt-2 pb-0.5 mt-1'}`}
      data-message-mine={isMine || undefined}
      onMouseEnter={onMessagePointerEnter}
      onMouseLeave={onMessagePointerLeave}
      onClick={onMessageTap}
    >
      {burst}
      {/* gutter: avatar or hover timestamp */}
      <div className="relative w-9 shrink-0">
        {grouped ? (
          // Absolute + nowrap so the hover timestamp never reflows the row height.
          <span className="absolute right-0 top-0.5 whitespace-nowrap text-3xs leading-5 tabular-nums text-[var(--color-text-faint)] opacity-0 group-hover:opacity-100 max-md:hidden">
            {message.encrypted && (
              <span className="mr-1 inline-flex align-[-1px]" title="End-to-end encrypted">
                <LockIcon size={9} />
              </span>
            )}
            {fmtTime(message.created_at)}
          </span>
        ) : (
          <Avatar id={message.user.id} name={message.user.display_name} size={36} online={online} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <UserChip
              userId={message.user.id}
              fallbackName={message.user.display_name}
              className="text-sm font-semibold text-[var(--color-text)] hover:underline"
            >
              {authorName}
            </UserChip>
            <span className="text-2xs text-[var(--color-text-faint)]">
              {message.encrypted && (
                <span className="mr-1 inline-flex align-[-1px]" title="End-to-end encrypted">
                  <LockIcon size={9} />
                </span>
              )}
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
              <Button size="xs" onClick={saveEdit}>
                Save
              </Button>
              <Button variant="outline" size="xs" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <span className="text-2xs text-[var(--color-text-faint)]">
                Enter to save · Esc to cancel
              </span>
            </div>
          </div>
        ) : (
          <div className="pr-8">
            <RenderedMessageContent message={message} highlight={focusQuery} />
            {message.edited_at && (
              <span className="ml-1 align-baseline text-3xs text-[var(--color-text-faint)]">
                (edited)
              </span>
            )}
          </div>
        )}

        {/* attachments */}
        {!isDeleted && !editing && message.attachments.length > 0 &&
          (!message.encrypted || typeof message.decryptedText === 'string') && (
          <AttachmentList attachments={message.attachments} />
        )}

        {/* reactions */}
        {!isDeleted && message.reactions.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={(event) => react(r.emoji, event.currentTarget)}
                className={`reaction-chip flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition ${
                  r.me
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                    : 'border-[var(--color-border)] bg-[var(--color-panel)] text-[var(--color-text-dim)] hover:border-[var(--color-text-faint)]'
                }`}
              >
                <span className="reaction-emoji">{r.emoji}</span>
                <span className="reaction-count tabular-nums">{r.count}</span>
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
                      react(e)
                      closePalette()
                    }}
                    className="reaction-palette-item rounded-md px-1.5 py-1 text-base hover:bg-[var(--color-accent-soft)]"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ToolbarBtn title="Reply (R)" onClick={() => setReplyTarget(message.channel_id, message)}>
            <Icon name="reply" />
          </ToolbarBtn>
          {showThread && (
            <ToolbarBtn title="Reply in thread (T)" onClick={() => openThread(message.id)}>
              <Icon name="thread" />
            </ToolbarBtn>
          )}
          {canTask && (
            <ToolbarBtn title="Create task" onClick={() => setTaskModal(true)}>
              <Icon name="task" />
            </ToolbarBtn>
          )}
          {canEdit && (
            <ToolbarBtn title="Edit" onClick={() => setEditing(true)}>
              <Icon name="edit" />
            </ToolbarBtn>
          )}
          {isMine &&
            (confirmDelete ? (
              <div className="flex items-center gap-0.5 pl-0.5">
                <Button variant="danger" size="xs" onClick={doDelete}>
                  Delete
                </Button>
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
      {taskModalEl}
    </div>
  )
}

function RenderedMessageContent({ message, highlight }: { message: Message; highlight?: string }) {
  if (!message.encrypted) {
    return message.content ? <Markdown content={message.content} highlight={highlight} /> : null
  }
  if (message.decryptedText === undefined) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-sm text-[var(--color-text-faint)]">
        <span className="skeleton h-3 w-16 rounded" aria-hidden />
        <span>Decrypting…</span>
      </div>
    )
  }
  if (message.decryptedText === null) {
    return (
      <div className="py-0.5 text-sm italic text-[var(--color-text-faint)]">
        Can't decrypt — sent to another device
      </div>
    )
  }
  return message.decryptedText ? (
    <Markdown content={message.decryptedText} highlight={highlight} />
  ) : null
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
      className={`message-toolbar-button flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-faint)] transition-colors hover:bg-[var(--color-panel)] ${
        danger ? 'hover:text-danger-fg' : 'hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}
