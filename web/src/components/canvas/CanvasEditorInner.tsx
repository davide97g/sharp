import { useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
// Must precede the editor import: it sets window.EXCALIDRAW_ASSET_PATH, which is
// what keeps font loading on our own origin instead of a CDN.
import '../../lib/excalidrawAssets'
import '@excalidraw/excalidraw/index.css'
import { Excalidraw } from '@excalidraw/excalidraw'
import { SharpDocProvider, type DocConnStatus, type DocRoleByte } from '../../lib/docSync'
import { useExcalidrawYjs } from '../../lib/excalidrawYjs'
import { resolveScheme } from '../../lib/theme'
import { useStore } from '../../store'

import type { DocPeer as Peer } from '../../lib/types'
export type { DocPeer as Peer } from '../../lib/types'

export function CanvasEditorInner({
  docId,
  user,
  editable,
  viewOnly,
  onStatus,
  onPeers,
}: {
  docId: string
  user: { name: string; color: string }
  editable: boolean
  /**
   * Local, self-imposed read-only: the viewer *may* edit but asked not to (the
   * presentation toggle). Distinct from `editable`, which is the role gate — this
   * one is per-tab, nothing is persisted, and it is safe to flip mid-session
   * because the Yjs binding reads `canEdit` through a ref.
   */
  viewOnly?: boolean
  onStatus: (status: DocConnStatus) => void
  onPeers: (peers: Peer[]) => void
}) {
  const [role, setRole] = useState<DocRoleByte>(editable ? 'editor' : 'viewer')
  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const me = useStore((s) => s.me)
  const ui = useStore((s) => s.ui)

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
        // Track status locally (to gate the editor mount) and forward it up.
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

  const canEdit = editable && role === 'editor' && !viewOnly

  // Excalidraw scene bound to our Y.Doc + Awareness. `synced` gates the mount,
  // so an empty default scene can never be written over server state.
  const yjs = useExcalidrawYjs({
    docId,
    doc: provider.doc,
    awareness: provider.awareness,
    user: { id: me?.id ?? '', name: user.name, color: user.color },
    canEdit,
    synced: status === 'connected',
  })

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
        {yjs.ready && yjs.initialData ? (
          <Excalidraw
            initialData={yjs.initialData}
            excalidrawAPI={yjs.setApi}
            onChange={yjs.onChange}
            onPointerUpdate={yjs.onPointerUpdate}
            isCollaborating={yjs.peerCount > 0}
            viewModeEnabled={!canEdit}
            theme={resolveScheme(ui.scheme)}
            // The scene lives in the doc; loading a .excalidraw file over it would
            // fight the CRDT, so that action stays off.
            UIOptions={{ canvasActions: { loadScene: false } }}
          />
        ) : null}
      </div>
    </div>
  )
}
