import { useEffect, useState, type MouseEvent } from 'react'
import { ArrowRightIcon, Card, DocIcon, HashIcon, SectionLabel } from '../ui'
import { channelLabel, fmtRelative } from '../lib/util'
import { navigateTo } from '../lib/nav'
import { useStore } from '../store'

export function DocMessageCard({ id, fallbackTitle }: { id: string; fallbackTitle: string }) {
  const doc = useStore((s) => s.docMeta[id])
  const fetchDoc = useStore((s) => s.fetchDoc)
  const channels = useStore((s) => s.channels)
  const nicknames = useStore((s) => s.nicknames)
  const openDocPeek = useStore((s) => s.openDocPeek)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (doc || unavailable) return
    let active = true
    void fetchDoc(id).catch(() => {
      if (active) setUnavailable(true)
    })
    return () => {
      active = false
    }
  }, [doc, fetchDoc, id, unavailable])

  const channel = doc ? channels.find((item) => item.id === doc.channel_id) : undefined
  const title = doc?.title || fallbackTitle || 'Untitled'
  const preview = doc?.preview.trim()

  function open() {
    const path = window.location.pathname
    const inChat = path === '/' || path.startsWith('/c/')
    if (inChat) openDocPeek(id)
    else navigateTo(`/d/${id}`)
  }

  return (
    <Card
      as="button"
      type="button"
      interactive
      padding="none"
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        open()
      }}
      aria-label={`Open document ${title}`}
      className="group/doc my-1 w-[min(24rem,calc(100vw-7rem))] max-w-full overflow-hidden"
    >
      <div className="flex min-h-32">
        <span className="w-1 shrink-0 bg-accent" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col p-3">
          <span className="flex items-start justify-between gap-3">
            <span className="flex min-w-0 items-center gap-2">
              <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-accent-soft text-accent-hover">
                {doc?.icon ? (
                  <span className="text-lg leading-none" aria-hidden>
                    {doc.icon}
                  </span>
                ) : (
                  <DocIcon size={19} />
                )}
                <span
                  className="absolute right-0 top-0 h-2.5 w-2.5 border-b border-l border-border bg-panel"
                  aria-hidden
                />
              </span>
              <span className="min-w-0">
                <SectionLabel as="span" size="3xs" tone="accent">
                  Document
                </SectionLabel>
                <span className="mt-0.5 block truncate text-sm font-semibold text-text">
                  {title}
                </span>
              </span>
            </span>
            {doc ? (
              <span className="shrink-0 text-3xs tabular-nums text-text-faint">
                {fmtRelative(doc.updated_at)}
              </span>
            ) : null}
          </span>

          <span className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-text-dim">
            {preview ||
              (unavailable
                ? 'Document details are unavailable.'
                : 'Open this document to read and collaborate.')}
          </span>

          <span className="mt-auto flex items-center justify-between gap-3 border-t border-border-soft pt-2">
            <span className="flex min-w-0 items-center gap-1 text-2xs text-text-faint">
              {channel ? (
                <>
                  <HashIcon size={11} />
                  <span className="truncate">{channelLabel(channel, nicknames)}</span>
                </>
              ) : (
                <span>Sharp Docs</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-2xs font-medium text-accent-hover">
              Open doc
              <ArrowRightIcon
                size={12}
                className="transition-transform duration-(--motion-snap) group-hover/doc:translate-x-0.5"
              />
            </span>
          </span>
        </span>
      </div>
    </Card>
  )
}
