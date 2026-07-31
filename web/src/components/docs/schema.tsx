import { useEffect, useRef, useState } from 'react'
import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import { chipLabel, resolveChip } from '../../lib/docLinkify'
import { hostOf, useProxiedImage, usePreview } from '../../lib/linkPreviews'
import { navigateTo } from '../../lib/nav'
import { LinkPreviewCard } from '../LinkPreview'
import { BoardEmbed } from './BoardEmbed'
import { Tooltip } from '../../ui'

// Custom inline content: @person mention. Props serialize to XML attributes
// (userId, name) that the server scans for doc-mention bridging.
export const MentionSpec = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      userId: { default: '' },
      name: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => (
      <span className="rounded bg-[var(--color-accent-soft)] px-1 font-medium text-[var(--color-accent-hover)]">
        @{props.inlineContent.props.name}
      </span>
    ),
  },
)

// Custom inline content: [[doc]] link. Serializes to <doclink docId="…"/> which
// compaction scans for backlinks. Clicking navigates to the target doc.
export const DocLinkSpec = createReactInlineContentSpec(
  {
    type: 'doclink',
    propSchema: {
      docId: { default: '' },
      title: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => {
      const { docId, title } = props.inlineContent.props
      return (
        <span
          role="link"
          tabIndex={0}
          onClick={() => docId && navigateTo(`/d/${docId}`)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ' ') && docId) navigateTo(`/d/${docId}`)
          }}
          className="cursor-pointer rounded border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 text-[var(--color-accent-hover)] underline decoration-dotted underline-offset-2 hover:border-[var(--color-accent)]"
        >
          📄 {title || 'Untitled'}
        </span>
      )
    },
  },
)

// Custom inline content: a URL chip. `title`/`favicon` are the unfurl, captured
// once by whoever wrote the link (see lib/docLinkify.ts) and stored in the props,
// so opening a doc full of links costs a reader nothing. Full URL on hover.
export const UrlChipSpec = createReactInlineContentSpec(
  {
    type: 'urlchip',
    propSchema: {
      url: { default: '' },
      title: { default: '' },
      favicon: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => <UrlChipView {...props} />,
  },
)

function UrlChipView({
  inlineContent,
  updateInlineContent,
  editor,
}: {
  inlineContent: { props: { url: string; title: string; favicon: string } }
  updateInlineContent: (update: {
    type: 'urlchip'
    props: { url: string; title: string; favicon: string }
  }) => void
  editor: { isEditable: boolean }
}) {
  const { url, title, favicon } = inlineContent.props
  const icon = useProxiedImage(favicon || null)
  const label = chipLabel(inlineContent.props)

  // Self-heal: a chip written while the resolve was rate-limited (or offline)
  // has no title. The first *editor* to render it fills it in — never a viewer,
  // who has no write access and shouldn't be unfurling on someone else's behalf.
  const healed = useRef(false)
  useEffect(() => {
    if (!url || title || healed.current || !editor.isEditable) return
    healed.current = true
    resolveChip(url).then((chip) => {
      if (!chip.props.title && !chip.props.favicon) return
      updateInlineContent(chip)
    })
    // updateInlineContent is a fresh closure per render; the ref guard is what
    // keeps this to one resolve per chip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, title, editor.isEditable])

  return (
    <Tooltip label={url || 'No link'} className="align-baseline">
      <a
        href={url || undefined}
        target="_blank"
        rel="noreferrer noopener"
        contentEditable={false}
        className="inline-flex max-w-[24rem] items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel-2)] px-1.5 py-0.5 align-baseline text-[0.95em] leading-snug text-[var(--color-accent-hover)] no-underline transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
      >
        {icon ? (
          <img src={icon} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
        ) : (
          <span aria-hidden className="shrink-0 text-[0.8em]">
            🔗
          </span>
        )}
        <span className="truncate">{label}</span>
      </a>
    </Tooltip>
  )
}

// Custom block: a bookmark — the same unfurl card chat shows, as a block. Only
// the URL is stored; the card itself is resolved (and cached) per viewer, so a
// site that changes its title or art is not frozen into the doc.
export const BookmarkSpec = createReactBlockSpec(
  {
    type: 'bookmark',
    propSchema: { url: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => (
      <div contentEditable={false} className="my-1">
        <BookmarkView
          url={block.props.url}
          editable={editor.isEditable}
          onUrl={(url) => editor.updateBlock(block, { props: { url } })}
          onRemove={() => editor.removeBlocks([block])}
        />
      </div>
    ),
  },
)

function BookmarkView({
  url,
  editable,
  onUrl,
  onRemove,
}: {
  url: string
  editable: boolean
  onUrl: (url: string) => void
  onRemove: () => void
}) {
  const [draft, setDraft] = useState('')
  const preview = usePreview(url || null)

  if (!url) {
    // Empty bookmark: the /bookmark slash path, waiting for a link.
    if (!editable) return null
    return (
      <div className="flex max-w-md items-center gap-2 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const next = draft.trim()
              if (/^https?:\/\//i.test(next)) onUrl(next)
            }
            if (e.key === 'Escape') onRemove()
          }}
          placeholder="Paste a link…"
          className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
        />
      </div>
    )
  }

  if (preview === undefined) {
    return <div className="skeleton h-24 w-full max-w-md rounded-xl" />
  }
  if (preview === null) {
    // Nothing to unfurl (dead link, or previews disabled server-side): the link
    // itself is still the point.
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="flex max-w-md items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2 text-sm text-[var(--color-accent-hover)] no-underline hover:border-[var(--color-accent)]"
      >
        <span aria-hidden>🔗</span>
        <span className="truncate">{hostOf(url)}</span>
      </a>
    )
  }
  return <LinkPreviewCard preview={preview} />
}

// Custom block: an embedded, fully interactive board. `docId` ('' = unbound)
// points at the board `docs` row this block mirrors. Content is 'none' (atom
// block); the server's compaction only reads known tags, so it ignores this.
export const BoardEmbedSpec = createReactBlockSpec(
  {
    type: 'boardembed',
    propSchema: { docId: { default: '' } },
    content: 'none',
  },
  {
    render: ({ block, editor }) => (
      <BoardEmbed
        docId={block.props.docId}
        onBind={(docId) => editor.updateBlock(block, { props: { docId } })}
        onRemove={() => editor.removeBlocks([block])}
      />
    ),
  },
)

export const docSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    boardembed: BoardEmbedSpec(),
    bookmark: BookmarkSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionSpec,
    doclink: DocLinkSpec,
    urlchip: UrlChipSpec,
  },
})

export type DocBlockNoteEditor = typeof docSchema.BlockNoteEditor
