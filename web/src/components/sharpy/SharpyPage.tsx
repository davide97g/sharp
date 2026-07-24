import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fmtRelative } from '../../lib/util'
import { useIsMobile } from '../../lib/useMediaQuery'
import type { SharpySource } from '../../lib/types'
import { useStore } from '../../store'
import { Markdown } from '../Markdown'
import { SharpyCitationChips } from './SharpyCitationChips'
import { StreamShield } from '../stream/StreamShield'
import { Card, CloseIcon, PlusIcon } from '../../ui'
// TODO(ds): local SparkleIcon (organic 2-path brand glyph), SendIcon (up-arrow),
// TrashIcon + HistoryIcon (distinct/not-in-registry) kept — ui glyphs differ visually.

const SUGGESTED_PROMPTS = [
  'What did we decide about ',
  'Summarize this channel this week',
  'Draft a doc outline for ',
]

export function SharpyPage() {
  const enabled = useStore((s) => s.sharpyEnabled)
  const statusChecked = useStore((s) => s.sharpyStatusChecked)
  const conversations = useStore((s) => s.sharpyConversations)
  const activeId = useStore((s) => s.sharpyActiveId)
  const messages = useStore((s) => s.sharpyMessages)
  const loading = useStore((s) => s.sharpyLoading)
  const streaming = useStore((s) => s.sharpyStreaming)
  const streamText = useStore((s) => s.sharpyStreamText)
  const streamSources = useStore((s) => s.sharpyStreamSources)
  const openConversation = useStore((s) => s.openSharpyConversation)
  const newConversation = useStore((s) => s.newSharpyConversation)
  const deleteConversation = useStore((s) => s.deleteSharpyConversation)
  const sendSharpy = useStore((s) => s.sendSharpy)
  const isMobile = useIsMobile()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    if (!isMobile) setHistoryOpen(false)
  }, [isMobile])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streamText, streamSources, loading])

  if (!statusChecked) {
    return <div className="flex flex-1 bg-[var(--color-ink)]" aria-busy="true" />
  }

  if (!enabled) {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-4 bg-[var(--color-ink)] px-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <svg
            width="26"
            height="26"
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
        </span>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">Sharpy is off on this server</h1>
        <p className="max-w-md text-sm text-[var(--color-text-dim)]">
          Workspace AI answers need an AI provider. A server admin can enable Sharpy by
          setting the <code className="rounded bg-[var(--color-panel)] px-1.5 py-0.5 text-[12px]">AI_API_KEY</code> environment
          variable (plus optional <code className="rounded bg-[var(--color-panel)] px-1.5 py-0.5 text-[12px]">AI_BASE_URL</code> and
          model settings), then restarting the server.
        </p>
      </div>
    )
  }

  function submit() {
    const text = input.trim()
    if (!text || streaming) return
    stickRef.current = true
    void sendSharpy(text)
    setInput('')
  }

  function onComposerKey(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  function fillPrompt(prompt: string) {
    setInput(prompt)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      const el = textareaRef.current
      if (el) el.selectionStart = el.selectionEnd = el.value.length
    })
  }

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  function startNewConversation() {
    newConversation()
    setInput('')
    setHistoryOpen(false)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function selectConversation(id: string) {
    void openConversation(id)
    setHistoryOpen(false)
  }

  const isEmpty = !loading && messages.length === 0 && !streaming

  return (
    <StreamShield label="Sharpy hidden">
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-[var(--color-ink)]">
      <aside
        id="sharpy-history"
        className={`min-h-0 shrink-0 flex-col border-[var(--color-border)] bg-[var(--color-panel)] ${
          isMobile
            ? historyOpen
              ? 'flex flex-1 border-0'
              : 'hidden'
            : 'flex w-[260px] border-r'
        }`}
        aria-label="Sharpy conversations"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3">
          <div className="flex min-w-0 items-center gap-2">
            {isMobile && (
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--color-text-dim)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                aria-label="Close conversations"
              >
                <CloseIcon size={18} strokeWidth={1.8} />
              </button>
            )}
            <span className="text-sm font-semibold text-[var(--color-text)]">Chats</span>
          </div>
          <button
            type="button"
            onClick={startNewConversation}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--color-text-dim)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            aria-label="New chat"
            title="New chat"
          >
            <PlusIcon size={18} strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-[var(--color-text-faint)]">
              No conversations yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {conversations.map((conversation) => (
                <li key={conversation.id} className="group flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => selectConversation(conversation.id)}
                    className={`flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-[var(--color-panel-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                      conversation.id === activeId ? 'bg-[var(--color-ink)]' : ''
                    }`}
                  >
                    <span className="w-full truncate text-sm text-[var(--color-text)]">
                      {conversation.title}
                    </span>
                    <span className="text-2xs text-[var(--color-text-faint)]">
                      {fmtRelative(conversation.updated_at)}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteConversation(conversation.id)}
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-faint)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                      isMobile ? '' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    aria-label={`Delete ${conversation.title}`}
                    title="Delete conversation"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main
        className={`min-h-0 flex-1 flex-col ${isMobile && historyOpen ? 'hidden' : 'flex'}`}
        aria-label="Sharpy chat"
      >
        <header className={`flex h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-3 ${isMobile ? '' : 'hidden'}`}>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="flex h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-[var(--color-text-dim)] transition hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            aria-expanded={historyOpen}
            aria-controls="sharpy-history"
          >
            <HistoryIcon />
            Chats
          </button>
          <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text)]">
            <SparkleIcon />
            Sharpy
          </span>
          <button
            type="button"
            onClick={startNewConversation}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--color-text-dim)] transition hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            aria-label="New chat"
          >
            <PlusIcon size={18} strokeWidth={1.8} />
          </button>
        </header>

        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-8 sm:px-8 sm:py-12">
            {loading ? (
              <div className="space-y-4">
                <div className="skeleton h-12" />
                <div className="skeleton h-24" />
              </div>
            ) : isEmpty ? (
              <EmptyState onPick={fillPrompt} />
            ) : (
              <div className="flex flex-col gap-7 pb-6">
                {messages.map((message) =>
                  message.role === 'user' ? (
                    <UserMessage key={message.id} content={message.content} />
                  ) : (
                    <AssistantMessage key={message.id} content={message.content} sources={message.sources} />
                  ),
                )}
                {streaming && (
                  <AssistantMessage content={streamText} sources={streamSources} streaming />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-ink)] px-4 pb-4 pt-3 sm:px-8">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 focus-within:border-[var(--color-accent)]">
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={onComposerKey}
                disabled={streaming}
                placeholder={streaming ? 'Sharpy is thinking…' : 'Message Sharpy…'}
                className="max-h-40 min-h-7 flex-1 resize-none bg-transparent text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] disabled:opacity-60 sm:text-sm"
              />
              <button
                type="button"
                onClick={submit}
                disabled={streaming || !input.trim()}
                aria-label="Send message"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent)] text-[var(--color-text)] transition hover:bg-[var(--color-accent-hover)] disabled:cursor-default disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-ink)]"
              >
                <SendIcon />
              </button>
            </div>
            <p className="mt-1.5 px-1 text-center text-2xs text-[var(--color-text-faint)]">
              Answers grounded in your workspace messages and docs.
            </p>
          </div>
        </div>
      </main>
    </div>
    </StreamShield>
  )
}

function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="m-auto flex w-full max-w-xl flex-col items-center gap-6 py-10 text-center sm:py-16">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
        <SparkleIcon large />
      </div>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--color-text)] sm:text-4xl">
          Ask Sharpy
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--color-text-dim)]">
          Find decisions, summarize work, and draft from your workspace context.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-3">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <Card
            key={prompt}
            as="button"
            interactive
            type="button"
            onClick={() => onPick(prompt)}
            className="text-sm text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
          >
            {prompt.trim()}
            {prompt.endsWith(' ') ? '…' : ''}
          </Card>
        ))}
      </div>
    </div>
  )
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-[var(--color-accent)] px-4 py-2.5 text-sm leading-relaxed text-[var(--color-text)]">
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-dim)]">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <SparkleIcon />
        </span>
        Sharpy
      </div>
      <div className="text-sm leading-7 text-[var(--color-text)]">
        {content ? <Markdown content={content} /> : streaming ? <TypingIndicator /> : null}
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

function SparkleIcon({ large }: { large?: boolean }) {
  const size = large ? 26 : 18
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
