import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import { filterSuggestionItems } from '@blocknote/core'
import {
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import { docSchema, type DocBlockNoteEditor } from './schema'
import { DocEmbedContext } from './BoardEmbed'
import { SharpDocProvider, type DocConnStatus, type DocRoleByte } from '../../lib/docSync'
import { useStore } from '../../store'
import { api, fetchAttachmentBlob } from '../../lib/api'
import {
  bareUrl,
  chipFor,
  isBareAutoLink,
  linkifyContent,
  resolveChipProps,
  urlsInContent,
} from '../../lib/docLinkify'
import { toastError } from '../../lib/toast'

import type { DocPeer as Peer } from '../../lib/types'
export type { DocPeer as Peer } from '../../lib/types'

const DOC_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

function resolveDocFileUrl(
  url: string,
  resolvedUrls: Map<string, Promise<string>>,
): Promise<string> {
  // Existing URL embeds remain browser-resolved. Only Sharp attachment paths
  // need an authenticated fetch before BlockNote can render them.
  if (!url.startsWith('/api/v1/files/')) return Promise.resolve(url)

  const cached = resolvedUrls.get(url)
  if (cached) return cached

  const resolved = fetchAttachmentBlob(url).then((blob) => URL.createObjectURL(blob))
  resolvedUrls.set(url, resolved)
  resolved.catch(() => {
    if (resolvedUrls.get(url) === resolved) resolvedUrls.delete(url)
  })
  return resolved
}

// ── URL chips and bookmarks ──────────────────────────────────────────────────────────
//
// `lib/docLinkify.ts` owns the rules (what counts as a URL, what a chip carries);
// this file owns *when* they run. Three moments, deliberately no more — a doc is
// collaborative, so every rewrite is an edit everyone sees:
//
//   • paste, in `pasteHandler` below
//   • the block you just finished typing in (`linkifyTyped`)
//   • one backfill pass per doc open (`backfillDoc`), for docs written before
//     chips existed
//
// Blocks whose text is shown rather than linked are skipped, same as chat skips
// fenced code.
const NO_LINKIFY = new Set(['codeBlock'])

type EditableBlock = { id: string; type: string; content?: unknown }

function linkifiableContent(block: EditableBlock): readonly unknown[] | null {
  if (NO_LINKIFY.has(block.type) || !Array.isArray(block.content)) return null
  return block.content as readonly unknown[]
}

type ContentUpdate = Parameters<DocBlockNoteEditor['updateBlock']>[1]

function writeContent(editor: DocBlockNoteEditor, blockId: string, content: unknown[]): void {
  editor.updateBlock(blockId, { content } as unknown as ContentUpdate)
}

/** Ordered flat list of every block, nesting included. */
function allBlocks(editor: DocBlockNoteEditor): EditableBlock[] {
  const out: EditableBlock[] = []
  editor.forEachBlock((block) => {
    out.push(block as EditableBlock)
    return true
  })
  return out
}

function isEmptyBlock(block: EditableBlock): boolean {
  return Array.isArray(block.content) && block.content.length === 0
}

/**
 * Convert a URL the writer just finished typing. "Finished" means either
 * BlockNote auto-linked it (which it does once the URL is unambiguous) or the
 * writer typed the whitespace that ends it — a URL still growing under the caret
 * is left alone. Enter is the third case: the URL is now the tail of the block
 * *above* an empty cursor block, so that block is swept too.
 *
 * The caret is only re-homed when the rewrite touched the tail of the block,
 * which is where the caret already is in the case this exists for.
 */
function linkifyTyped(editor: DocBlockNoteEditor): void {
  const cursor = editor.getTextCursorPosition()
  const block = cursor.block as EditableBlock
  const content = linkifiableContent(block)
  if (content && content.length > 0) {
    const next = linkifyContent(content, { terminatedOnly: true })
    if (next) {
      const last = content[content.length - 1] as { type?: string; text?: string }
      const tailChanged =
        isBareAutoLink(last) || (last.type === 'text' && /\s$/.test(last.text ?? ''))
      writeContent(editor, block.id, next)
      if (tailChanged) editor.setTextCursorPosition(block.id, 'end')
      return
    }
  }
  // Enter on a line ending in a URL: the URL is now the tail of the block above,
  // with no whitespace after it. Sweep that block; the caret stays put.
  if (!isEmptyBlock(block)) return
  const blocks = allBlocks(editor)
  const index = blocks.findIndex((b) => b.id === block.id)
  const previous = index > 0 ? blocks[index - 1] : undefined
  if (!previous) return
  const previousContent = linkifiableContent(previous)
  if (!previousContent) return
  const next = linkifyContent(previousContent)
  if (next) writeContent(editor, previous.id, next)
}

/**
 * One-shot pass over a doc that still holds plain-text URLs. Titles are resolved
 * first so the chips land labelled in a single edit rather than healing one by
 * one, and the whole thing is skipped unless the caller is alone in the doc —
 * two clients rewriting the same text would merge into duplicated chips.
 */
async function backfillDoc(editor: DocBlockNoteEditor): Promise<void> {
  const blocks = allBlocks(editor).filter((b) => {
    const content = linkifiableContent(b)
    return content ? urlsInContent(content).length > 0 : false
  })
  if (blocks.length === 0) return

  const urls: string[] = []
  for (const block of blocks) {
    for (const url of urlsInContent(linkifiableContent(block)!)) {
      if (!urls.includes(url)) urls.push(url)
    }
  }
  const titles = await resolveChipProps(urls)

  for (const block of blocks) {
    // The doc may have moved on while the unfurls were in flight — re-read.
    const fresh = editor.getBlock(block.id) as EditableBlock | undefined
    const content = fresh ? linkifiableContent(fresh) : null
    if (!content) continue
    const next = linkifyContent(content, { titles })
    if (next) writeContent(editor, block.id, next)
  }
}

export function DocEditorInner({
  docId,
  channelId,
  user,
  editable,
  onStatus,
  onPeers,
}: {
  docId: string
  channelId: string
  user: { name: string; color: string }
  editable: boolean
  onStatus: (status: DocConnStatus) => void
  onPeers: (peers: Peer[]) => void
}) {
  const [role, setRole] = useState<DocRoleByte>(editable ? 'editor' : 'viewer')
  const [synced, setSynced] = useState(false)
  const loadMembers = useStore((s) => s.loadMembers)

  // The provider is built once, so it must not close over this render's props.
  const statusRef = useRef(onStatus)
  statusRef.current = onStatus

  // One Y.Doc + provider per mount (component is keyed by docId upstream).
  // Lazily initialised via a ref so React StrictMode's double-render doesn't
  // create two of everything.
  const holder = useRef<{
    ydoc: Y.Doc
    provider: SharpDocProvider
    resolvedUrls: Map<string, Promise<string>>
  } | null>(null)
  if (!holder.current) {
    const ydoc = new Y.Doc()
    holder.current = {
      ydoc,
      provider: new SharpDocProvider({
        docId,
        doc: ydoc,
        user,
        onStatus: (status) => {
          statusRef.current(status)
          if (status === 'connected') setSynced(true)
        },
        onRole: setRole,
      }),
      resolvedUrls: new Map(),
    }
  }
  const { ydoc, provider, resolvedUrls } = holder.current
  const teardownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useCreateBlockNote(
    {
      schema: docSchema,
      collaboration: {
        fragment: ydoc.getXmlFragment('blocknote'),
        user,
        provider: { awareness: provider.awareness },
      },
      uploadFile: async (file) => {
        const contentType = file.type.split(';', 1)[0].toLowerCase()
        if (!DOC_IMAGE_TYPES.has(contentType)) {
          const message = 'Docs only accept PNG, JPEG, GIF, WebP, or AVIF images'
          toastError(message)
          throw new Error(message)
        }
        try {
          const attachment = await api.uploadDocImage(docId, file)
          return { props: { name: attachment.filename, url: attachment.url } }
        } catch (error) {
          if (error instanceof Error) toastError(error.message)
          throw error
        }
      },
      resolveFileUrl: (url) => resolveDocFileUrl(url, resolvedUrls),
      // Pasting a bare URL: a bookmark card on an empty block, an inline chip
      // inside a line of text, and the plain default (a link over the selected
      // text) when there is a selection to label it with.
      pasteHandler: ({ event, editor: ed, defaultPasteHandler }) => {
        const url = bareUrl(event.clipboardData?.getData('text/plain') ?? '')
        if (!url) return defaultPasteHandler()
        const collapsed = ed.prosemirrorView?.state.selection.empty ?? true
        if (!collapsed) return defaultPasteHandler()
        const block = ed.getTextCursorPosition().block as EditableBlock
        if (block.type === 'paragraph' && isEmptyBlock(block)) {
          ed.updateBlock(block.id, {
            type: 'bookmark',
            props: { url },
          } as unknown as ContentUpdate)
          // Leave a line under the card so the caret has somewhere to land.
          const [trailing] = ed.insertBlocks([{ type: 'paragraph' }], block.id, 'after')
          ed.setTextCursorPosition(trailing.id, 'end')
        } else {
          // The chip lands unlabelled and fills its own title in on first render
          // (see UrlChipView) — no await, so the paste never feels laggy.
          ed.insertInlineContent([chipFor(url), ' '] as never)
        }
        return true
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const canEdit = editable && role === 'editor'

  useEffect(() => {
    editor.isEditable = canEdit
  }, [editor, canEdit])

  // Load channel members for the @ mention menu.
  useEffect(() => {
    loadMembers(channelId)
  }, [channelId, loadMembers])

  // Chip a URL as soon as it is terminated. Deferred out of the change dispatch
  // (ProseMirror is mid-transaction) and re-entrancy-guarded: the rewrite this
  // triggers finds only chips the second time round, so it settles immediately.
  useEffect(() => {
    if (!canEdit) return
    let scheduled = false
    return editor.onChange(() => {
      if (scheduled) return
      scheduled = true
      setTimeout(() => {
        scheduled = false
        if (!editor.isEditable) return
        try {
          linkifyTyped(editor)
        } catch {
          /* a linkify failure must never break typing */
        }
      }, 0)
    }, false)
  }, [editor, canEdit])

  // Backfill: docs written before chips existed still hold plain-text URLs.
  // Gated on being alone in the doc (concurrent rewrites of the same text merge
  // into duplicate chips) and delayed enough for peers to announce themselves.
  const backfilled = useRef(false)
  useEffect(() => {
    if (!synced || !canEdit || backfilled.current) return
    const timer = setTimeout(() => {
      if (backfilled.current) return
      const others = [...provider.awareness.getStates().keys()].filter(
        (id) => id !== ydoc.clientID,
      )
      if (others.length > 0) return
      backfilled.current = true
      backfillDoc(editor).catch(() => {})
    }, 1500)
    return () => clearTimeout(timer)
  }, [synced, canEdit, editor, provider, ydoc])

  // Socket lifecycle: connect on mount, disconnect on cleanup. Full teardown is
  // deferred so a StrictMode remount cancels it; only a real unmount tears down.
  useEffect(() => {
    if (teardownTimer.current) {
      clearTimeout(teardownTimer.current)
      teardownTimer.current = null
    }
    provider.connect()
    return () => {
      provider.disconnect()
      teardownTimer.current = setTimeout(() => {
        provider.destroy()
        ydoc.destroy()
        for (const resolved of resolvedUrls.values()) {
          resolved.then((url) => URL.revokeObjectURL(url)).catch(() => {})
        }
        resolvedUrls.clear()
      }, 1000)
    }
  }, [provider, resolvedUrls, ydoc])

  // Presence: report peers (excluding self) from awareness.
  useEffect(() => {
    const aw = provider.awareness
    const update = () => {
      const peers: Peer[] = []
      aw.getStates().forEach((state, clientId) => {
        if (clientId === ydoc.clientID) return
        const u = (state as { user?: { name: string; color: string } }).user
        if (u) peers.push({ clientId, name: u.name, color: u.color })
      })
      onPeers(peers)
    }
    aw.on('change', update)
    update()
    return () => aw.off('change', update)
  }, [provider, ydoc, onPeers])

  // --- @ mention suggestions (channel members) ---
  async function mentionItems(query: string): Promise<DefaultReactSuggestionItem[]> {
    const state = useStore.getState()
    const members = state.members[channelId] ?? []
    const meId = state.me?.id
    const q = query.toLowerCase()
    return members
      .filter((m) => m.display_name.toLowerCase().includes(q))
      .slice(0, 12)
      .map((m) => ({
        title: m.display_name,
        onItemClick: () => {
          editor.insertInlineContent([
            { type: 'mention', props: { userId: m.id, name: m.display_name } },
            ' ',
          ])
          if (m.id !== meId) {
            api.addDocMention(docId, m.id).catch((e) => {
              if (e instanceof Error) toastError(e.message)
            })
          }
        },
      }))
  }

  // --- [ doc-link suggestions (docs search) ---
  async function docLinkItems(query: string): Promise<DefaultReactSuggestionItem[]> {
    // The "[" trigger may leave a leading bracket in the query ("[[" typing).
    const q = query.replace(/^\[+/, '').trim()
    let results: { id: string; title: string; channelName?: string }[]
    if (q) {
      const res = await api.docSearch(q, 12)
      // doclink is doc-scoped (navigates to /d/); canvases are excluded.
      results = res.results
        .filter((d) => d.kind === 'doc')
        .map((d) => ({
          id: d.id,
          title: d.title || 'Untitled',
          channelName: d.channel_name,
        }))
    } else {
      const state = useStore.getState()
      const all = Object.values(state.docsByChannel).flat()
      results = all
        .filter((d) => !d.deleted_at && d.kind === 'doc')
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, 12)
        .map((d) => ({ id: d.id, title: d.title || 'Untitled' }))
    }
    return results.map((d) => ({
      title: d.title,
      subtext: d.channelName ? `#${d.channelName}` : undefined,
      onItemClick: () => {
        editor.insertInlineContent([
          { type: 'doclink', props: { docId: d.id, title: d.title } },
          ' ',
        ])
      },
    }))
  }

  // --- / slash menu (defaults + Board embed) ---
  // BlockNote's built-in slash menu is disabled (`slashMenu={false}`) so we can
  // append a custom item; `filterSuggestionItems` reproduces the default match.
  async function slashItems(query: string): Promise<DefaultReactSuggestionItem[]> {
    const boardItem: DefaultReactSuggestionItem = {
      title: 'Board',
      subtext: 'Embed a kanban board',
      aliases: ['board', 'kanban', 'embed'],
      group: 'Media',
      icon: <span style={{ fontSize: 18 }}>🗂️</span>,
      onItemClick: () => {
        editor.insertBlocks(
          [{ type: 'boardembed' }],
          editor.getTextCursorPosition().block,
          'after',
        )
      },
    }
    const bookmarkItem: DefaultReactSuggestionItem = {
      title: 'Bookmark',
      subtext: 'Preview card for a link',
      aliases: ['bookmark', 'link', 'url', 'embed', 'preview'],
      group: 'Media',
      icon: <span style={{ fontSize: 18 }}>🔗</span>,
      onItemClick: () => {
        editor.insertBlocks(
          [{ type: 'bookmark' }],
          editor.getTextCursorPosition().block,
          'after',
        )
      },
    }
    // Keep the Media group contiguous — appending at the end makes the menu
    // repeat the group label for every item run.
    const items = [...getDefaultReactSlashMenuItems(editor)]
    const lastMedia = items.map((i) => i.group).lastIndexOf('Media')
    items.splice(lastMedia === -1 ? items.length : lastMedia + 1, 0, boardItem, bookmarkItem)
    return filterSuggestionItems(items, query)
  }

  const embedCtx = useMemo(
    () => ({ channelId, user, hostEditable: canEdit }),
    [channelId, user, canEdit],
  )

  return (
    <div className="sharp-doc">
      <DocEmbedContext.Provider value={embedCtx}>
        <BlockNoteView editor={editor} editable={canEdit} theme="dark" slashMenu={false}>
          <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
          <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} minQueryLength={0} />
          <SuggestionMenuController triggerCharacter="[" getItems={docLinkItems} minQueryLength={0} />
        </BlockNoteView>
      </DocEmbedContext.Provider>
    </div>
  )
}
