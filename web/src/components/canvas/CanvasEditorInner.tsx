import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import 'tldraw/tldraw.css'
import { Tldraw, type Editor } from 'tldraw'
import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { SharpDocProvider, type DocConnStatus, type DocRoleByte } from '../../lib/docSync'
import { useYjsTldrawStore } from '../../lib/tldrawYjs'
import { useStore } from '../../store'

export type Peer = { clientId: number; name: string; color: string }

// Self-hosted tldraw assets (this app must never hit the tldraw CDN). Resolved
// once at module scope.
const assetUrls = getAssetUrlsByImport()

export function CanvasEditorInner({
  docId,
  user,
  editable,
  onStatus,
  onPeers,
}: {
  docId: string
  user: { name: string; color: string }
  editable: boolean
  onStatus: (status: DocConnStatus) => void
  onPeers: (peers: Peer[]) => void
}) {
  const [role, setRole] = useState<DocRoleByte>(editable ? 'editor' : 'viewer')
  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const me = useStore((s) => s.me)

  // One Y.Doc + provider per mount (component is keyed by docId upstream).
  // Lazily initialised via a ref so React StrictMode's double-render doesn't
  // create two of everything.
  const holder = useRef<{ ydoc: Y.Doc; provider: SharpDocProvider } | null>(null)
  if (!holder.current) {
    const ydoc = new Y.Doc()
    holder.current = {
      ydoc,
      provider: new SharpDocProvider({
        docId,
        doc: ydoc,
        user,
        // Track status locally (to gate the store's `synced`) and forward it up.
        onStatus: (s) => {
          setStatus(s)
          onStatus(s)
        },
        onRole: setRole,
      }),
    }
  }
  const { ydoc, provider } = holder.current
  const teardownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const canEdit = editable && role === 'editor'

  // tldraw store bound to our Y.Doc + Awareness. `synced` gates the initial
  // hydrate so we never seed defaults over authoritative server state.
  const storeWithStatus = useYjsTldrawStore({
    doc: provider.doc,
    awareness: provider.awareness,
    user: { id: me?.id ?? '', name: user.name, color: user.color },
    synced: status === 'connected',
  })

  // Read-only mirrors role: apply on mount and re-apply whenever it changes.
  const editorRef = useRef<Editor | null>(null)
  useEffect(() => {
    editorRef.current?.updateInstanceState({ isReadonly: !canEdit })
  }, [canEdit])

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

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Tldraw
          store={storeWithStatus}
          assetUrls={assetUrls}
          onMount={(editor) => {
            editorRef.current = editor
            editor.updateInstanceState({ isReadonly: !canEdit })
          }}
        />
      </div>
    </div>
  )
}
