import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store'
import { useIsMobile } from '../lib/useMediaQuery'
import { fmtRelative } from '../lib/util'
import { Markdown } from './Markdown'
import type { SharpySource } from '../lib/types'
import { SharpyCitationChips } from './sharpy/SharpyCitationChips'

const SUGGESTED_PROMPTS = [
  'What did we decide about ',
  'Summarize this channel this week',
  'Draft a doc outline for ',
]

export function SharpyPanel() {
  const navigate = useNavigate()
  const open = useStore((s) => s.sharpyOpen)
  const enabled = useStore((s) => s.sharpyEnabled)
  const messages = useStore((s) => s.sharpyMessages)
  const loading = useStore((s) => s.sharpyLoading)
  const streaming = useStore((s) => s.sharpyStreaming)
  const streamText = useStore((s) => s.sharpyStreamText)
  const streamSources = useStore((s) => s.sharpyStreamSources)
  const conversations = useStore((s) => s.sharpyConversations)
  const activeId = useStore((s) => s.sharpyActiveId)
  const setSharpyOpen = useStore((s) => s.setSharpyOpen)
  const openConversation = useStore((s) => s.openSharpyConversation)
  const newConversation = useStore((s) => s.newSharpyConversation)
  const deleteConversation = useStore((s) => s.deleteSharpyConversation)
  const sendSharpy = useStore((s) => s.sendSharpy)

  const isMobile = useIsMobile()
  const [input, setInput] = useState('')
  const [historyOpen, setHistoryOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Whether the view is pinned to the bottom (auto-scroll on new content).
  const stickRef = useRef(true)

  // Esc closes the panel.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSharpyOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setSharpyOpen])

  // Autofocus the composer when the panel opens.
  useEffect(() => {
    if (open && !historyOpen) textareaRef.current?.focus()
  }, [open, historyOpen])

  // Auto-scroll to bottom on new content unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamSources, loading])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  if (!open || !enabled) return null

  function submit() {
    const text = input.trim()
    if (!text || streaming) return
    stickRef.current = true
    void sendSharpy(text)
    setInput('')
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function fillPrompt(prompt: string) {
    setInput(prompt)
    textareaRef.current?.focus()
    // Place the caret at the end so trailing prompts read naturally.
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) el.selectionStart = el.selectionEnd = el.value.length
    })
  }

  const isEmpty = !loading && messages.length === 0 && !streaming

  return (
    <aside
      className={
        isMobile
          ? 'mobile-sheet'
          : 'flex w-[420px] shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)]'
      }
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile ? true : undefined}
      aria-label="Sharpy assistant"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-[var(--color-accent-hover)]" aria-hidden>
            <SparkleIcon />
          </span>
          <span className="text-sm font-semibold">Sharpy</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            title="Open full page"
            onClick={() => {
              setSharpyOpen(false)
              navigate('/sharpy')
            }}
          >
            <ExpandIcon />
          </IconButton>
          <IconButton
            title="Conversation history"
            active={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            <HistoryIcon />
          </IconButton>
          <IconButton
            title="New chat"
            onClick={() => {
              newConversation()
              setHistoryOpen(false)
              setInput('')
              requestAnimationFrame(() => textareaRef.current?.focus())
            }}
          >
            <PlusIcon />
          </IconButton>
          <IconButton title="Close (Esc)" onClick={() => setSharpyOpen(false)}>
            <CloseIcon />
          </IconButton>
        </div>
      </header>

      {historyOpen ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          {conversations.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-[var(--color-text-faint)]">
              No conversations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5 px-2">
              {conversations.map((c) => (
                <li key={c.id} className="group flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      void openConversation(c.id)
                      setHistoryOpen(false)
                    }}
                    className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-[var(--color-panel-2)] ${
                      c.id === activeId ? 'bg-[var(--color-panel)]' : ''
                    }`}
                  >
                    <span className="w-full truncate text-sm text-[var(--color-text)]">
                      {c.title}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-faint)]">
                      {fmtRelative(c.updated_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Delete conversation"
                    onClick={() => void deleteConversation(c.id)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--color-text-faint)] opacity-0 transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4"
          >
            {loading ? (
              <div className="space-y-3">
                <div className="skeleton h-10" />
                <div className="skeleton h-16" />
              </div>
            ) : isEmpty ? (
              <EmptyState onPick={fillPrompt} />
            ) : (
              <div className="flex flex-col gap-4">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <UserBubble key={m.id} content={m.content} />
                  ) : (
                    <AssistantMessage key={m.id} content={m.content} sources={m.sources} />
                  ),
                )}
                {streaming && (
                  <AssistantMessage
                    content={streamText}
                    sources={streamSources}
                    streaming
                  />
                )}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--color-border)] p-3">
            <div className="flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 focus-within:border-[var(--color-accent)]">
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onComposerKey}
                disabled={streaming}
                placeholder={streaming ? 'Sharpy is thinking…' : 'Ask Sharpy…'}
                className="max-h-40 min-h-[1.5rem] flex-1 resize-none bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-60"
              />
              <button
                type="button"
                onClick={submit}
                disabled={streaming || !input.trim()}
                aria-label="Send"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-white transition hover:bg-[var(--color-accent-hover)] disabled:cursor-default disabled:opacity-30"
              >
                <SendIcon />
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[11px] text-[var(--color-text-faint)]">
              Answers grounded in your workspace messages and docs.
            </p>
          </div>
        </>
      )}
    </aside>
  )
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-5 pt-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
        <SparkleIcon large />
      </div>
      <div>
        <p className="text-sm font-semibold text-[var(--color-text)]">Ask Sharpy</p>
        <p className="mt-1 text-xs text-[var(--color-text-faint)]">
          Grounded in your workspace messages and docs.
        </p>
      </div>
      <div className="flex w-full flex-col gap-2">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-left text-sm text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
          >
            {prompt.trim()}
            {prompt.endsWith(' ') ? '…' : ''}
          </button>
        ))}
      </div>
    </div>
  )
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--color-accent)] px-3.5 py-2 text-sm text-white">
        {content}
      </div>
    </div>
  )
}

function AssistantMessage({
  content,
  sources,
  streaming,
}: {
  content: string
  sources: SharpySource[] | null
  streaming?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm leading-relaxed text-[var(--color-text)]">
        {content ? (
          <Markdown content={content} />
        ) : streaming ? (
          <TypingIndicator />
        ) : null}
        {streaming && content ? <TypingIndicator inline /> : null}
      </div>
      {sources && sources.length > 0 && <SharpyCitationChips sources={sources} />}
    </div>
  )
}

function TypingIndicator({ inline }: { inline?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 align-middle ${inline ? 'ml-1' : ''}`}
      aria-label="Sharpy is thinking"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)] [animation-delay:0ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)] [animation-delay:150ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)] [animation-delay:300ms]" />
    </span>
  )
}

function IconButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] ${
        active
          ? 'bg-[var(--color-panel)] text-[var(--color-accent-hover)]'
          : 'text-[var(--color-text-dim)]'
      }`}
    >
      {children}
    </button>
  )
}

function SparkleIcon({ large }: { large?: boolean }) {
  const s = large ? 24 : 18
  return (
    <svg
      width={s}
      height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3c.4 4.7 2.3 6.6 7 7-4.7.4-6.6 2.3-7 7-.4-4.7-2.3-6.6-7-7 4.7-.4 6.6-2.3 7-7Z" />
      <path d="M18.5 16.5c.1 1.5.8 2.2 2.3 2.3-1.5.1-2.2.8-2.3 2.3-.1-1.5-.8-2.2-2.3-2.3 1.5-.1 2.2-.8 2.3-2.3Z" />
    </svg>
  )
}

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 8v4l3 2" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function ExpandIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 3h6v6M21 3l-7 7M9 21H3v-6M3 21l7-7" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 12 6-6 6 6M12 6v12" />
    </svg>
  )
}
