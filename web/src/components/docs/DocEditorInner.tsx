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
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'

export type Peer = { clientId: number; name: string; color: string }

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
  const holder = useRef<{ ydoc: Y.Doc; provider: SharpDocProvider } | null>(null)
  if (!holder.current) {
    const ydoc = new Y.Doc()
    holder.current = {
      ydoc,
      provider: new SharpDocProvider({ docId, doc: ydoc, user, onStatus, onRole: setRole }),
    }
  }
  const { ydoc, provider } = holder.current
  const teardownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editor = useCreateBlockNote(
    {
      schema: docSchema,
      collaboration: {
        fragment: ydoc.getXmlFragment('blocknote'),
        user,
        provider: { awareness: provider.awareness },
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
      }, 1000)
    }
  }, [provider, ydoc])

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
