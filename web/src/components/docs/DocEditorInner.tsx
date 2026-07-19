import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { BlockNoteView } from '@blocknote/mantine'
import '@blocknote/mantine/style.css'
import {
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from '@blocknote/react'
import { docSchema } from './schema'
import { SharpDocProvider, type DocConnStatus, type DocRoleByte } from '../../lib/docSync'
import { useStore } from '../../store'
import { api, fetchAttachmentBlob } from '../../lib/api'
import { toastError } from '../../lib/toast'

export type Peer = { clientId: number; name: string; color: string }

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
  const loadMembers = useStore((s) => s.loadMembers)

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
      provider: new SharpDocProvider({ docId, doc: ydoc, user, onStatus, onRole: setRole }),
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
        .filter((d) => d.kind !== 'canvas')
        .map((d) => ({
          id: d.id,
          title: d.title || 'Untitled',
          channelName: d.channel_name,
        }))
    } else {
      const state = useStore.getState()
      const all = Object.values(state.docsByChannel).flat()
      results = all
        .filter((d) => !d.deleted_at && d.kind !== 'canvas')
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

  return (
    <div className="sharp-doc">
      <BlockNoteView editor={editor} editable={canEdit} theme="dark">
        <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} minQueryLength={0} />
        <SuggestionMenuController triggerCharacter="[" getItems={docLinkItems} minQueryLength={0} />
      </BlockNoteView>
    </div>
  )
}
