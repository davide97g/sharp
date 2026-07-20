import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core'
import { createReactBlockSpec, createReactInlineContentSpec } from '@blocknote/react'
import { navigateTo } from '../../lib/nav'
import { BoardEmbed } from './BoardEmbed'

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
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    mention: MentionSpec,
    doclink: DocLinkSpec,
  },
})

export type DocBlockNoteEditor = typeof docSchema.BlockNoteEditor
