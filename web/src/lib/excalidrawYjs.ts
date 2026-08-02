// Binds an Excalidraw scene to a Y.Doc + y-protocols Awareness that we already
// own (SharpDocProvider). No Excalidraw collab server, no firebase.
// Verified against @excalidraw/excalidraw@0.18.1.
//
//   const yjs = useExcalidrawYjs({ docId, doc: provider.doc,
//                                  awareness: provider.awareness, user, canEdit,
//                                  synced: docStatus === 'connected' })
//   if (!yjs.ready) return null
//   return <Excalidraw initialData={yjs.initialData} excalidrawAPI={yjs.setApi}
//                      onChange={yjs.onChange} onPointerUpdate={yjs.onPointerUpdate} />
//
// Design notes (why it is written this way):
//  - The Y.Doc holds ONE entry per element, keyed by element id, under
//    `ydoc.getMap('excalidraw')`. Deleted elements stay as `isDeleted: true`
//    tombstones (Excalidraw's own model) instead of dropping the key, so a
//    delete and a concurrent edit still converge.
//  - Local -> Yjs writes use a plain doc.transact (null origin) so
//    SharpDocProvider forwards them to the server (it only skips origin === the
//    provider itself), batched to one transaction per animation frame.
//  - Yjs -> local goes through Excalidraw's own `reconcileElements` (per-element
//    LWW on version/versionNonce, local pointer/selection preserved) and lands
//    with `CaptureUpdateAction.NEVER` so remote work never enters local undo.
//  - Echo control is a version cache, not an origin flag: every element we send
//    or receive is remembered by versionNonce, and onChange only ships elements
//    whose nonce we have not seen.
//  - The `synced` gate keeps <Excalidraw> unmounted until the first server sync
//    landed, so an empty default scene can never overwrite server state.
//  - Images do NOT live in the Y.Doc: MAX_UPDATE_BYTES on the sync socket is
//    512 KB. They upload through the existing doc-image endpoint and only
//    `{ id, url, mimeType }` is shared; each client fetches the bytes itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { CaptureUpdateAction, reconcileElements, restoreElements } from '@excalidraw/excalidraw'
import type { RemoteExcalidrawElement } from '@excalidraw/excalidraw/data/reconcile'
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type {
  AppState,
  BinaryFiles,
  Collaborator,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
  SocketId,
} from '@excalidraw/excalidraw/types'
import { api, fetchAttachmentBlob } from './api'
import { toastError } from './toast'

/** Batch window for outgoing element writes (a drag fires onChange per pointer move). */
const FLUSH_MS = 33

/** What the server accepts for a doc image (`is_supported_doc_image` in files.rs). */
const UPLOADABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** Shared per-image record. The bytes live in sharp file storage, not in Yjs. */
type CanvasFileRef = {
  id: string
  /** Sharp attachment path, e.g. `/api/v1/files/<uuid>` — fetched authenticated. */
  url: string
  mimeType: string
  created: number
}

/** Awareness payload published under the `excalidrawPresence` field. */
type PresenceState = {
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  button?: 'up' | 'down'
  selectedElementIds?: AppState['selectedElementIds']
}

export interface ExcalidrawUser {
  /** Stable unique id (the sharp user UUID). */
  id: string
  name: string
  /** Any CSS color; drives this user's cursor color. */
  color: string
}

export interface UseExcalidrawYjsOptions {
  /** Canvas doc id — images upload against it. */
  docId: string
  /** The Y.Doc owned by SharpDocProvider. */
  doc: Y.Doc
  /** The y-protocols Awareness exposed by SharpDocProvider. */
  awareness: Awareness
  /** Current user, for multiplayer presence. */
  user: ExcalidrawUser
  /** False for viewers: the binding then never writes to the Y.Doc. */
  canEdit: boolean
  /**
   * Pass `true` once the provider has completed its FIRST server sync (i.e.
   * SharpDocProvider status has reached 'connected'). Internally sticky: once
   * true it stays true across reconnects.
   */
  synced?: boolean
  /** Y.Map key holding the elements. Default 'excalidraw'. */
  mapKey?: string
  /** Y.Map key holding image references. Default 'excalidraw_files'. */
  filesKey?: string
}

export interface ExcalidrawYjsBinding {
  /** Mount <Excalidraw> only when true. */
  ready: boolean
  /** Server scene snapshot, taken once when `ready` flips. */
  initialData: ExcalidrawInitialDataState | null
  /** Number of peers currently in the doc (drives `isCollaborating`). */
  peerCount: number
  setApi: (api: ExcalidrawImperativeAPI) => void
  onChange: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void
  onPointerUpdate: (payload: {
    pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
    button: 'down' | 'up'
  }) => void
}

/**
 * Y.Map iteration order is insertion order, which is NOT scene order. Excalidraw
 * derives z-order from each element's fractional `index` and repairs anything it
 * reads out of order, so every read out of the map has to be sorted first or
 * layering drifts between clients.
 */
function inSceneOrder(elements: OrderedExcalidrawElement[]): OrderedExcalidrawElement[] {
  return elements.sort((a, b) => {
    if (a.index === b.index) return a.id < b.id ? -1 : 1
    return a.index < b.index ? -1 : 1
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'))
    reader.readAsDataURL(blob)
  })
}

export function useExcalidrawYjs(options: UseExcalidrawYjsOptions): ExcalidrawYjsBinding {
  const {
    docId,
    doc,
    awareness,
    user,
    canEdit,
    synced = true,
    mapKey = 'excalidraw',
    filesKey = 'excalidraw_files',
  } = options

  const yElements = useMemo(
    () => doc.getMap<OrderedExcalidrawElement>(mapKey),
    [doc, mapKey],
  )
  const yFiles = useMemo(() => doc.getMap<CanvasFileRef>(filesKey), [doc, filesKey])

  // Sticky "ready": flips true the first time `synced` is true, then stays true
  // so a transient reconnect never re-hydrates over live local work.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (synced) setReady(true)
  }, [synced])

  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const canEditRef = useRef(canEdit)
  canEditRef.current = canEdit

  // id -> versionNonce we already know about (sent or received). The echo guard.
  const seenRef = useRef(new Map<string, number>())

  // ---- INITIAL SCENE -----------------------------------------------------
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null)
  useEffect(() => {
    if (!ready || initialData) return
    const stored = inSceneOrder([...yElements.values()])
    for (const element of stored) seenRef.current.set(element.id, element.versionNonce)
    setInitialData({
      elements: restoreElements(stored, null, { refreshDimensions: false }),
      scrollToContent: true,
    })
  }, [ready, initialData, yElements])

  // ---- LOCAL -> YJS ------------------------------------------------------
  // Batched with a timer, NOT requestAnimationFrame: rAF stops firing in a
  // hidden or occluded tab, which would leave the last edits sitting in
  // `pendingRef` un-shipped until the tab is looked at again.
  const pendingRef = useRef<readonly OrderedExcalidrawElement[] | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    flushTimer.current = null
    const elements = pendingRef.current
    pendingRef.current = null
    if (!elements || !canEditRef.current) return
    const seen = seenRef.current
    const changed = elements.filter((element) => seen.get(element.id) !== element.versionNonce)
    if (!changed.length) return
    doc.transact(() => {
      for (const element of changed) {
        yElements.set(element.id, element)
        seen.set(element.id, element.versionNonce)
      }
    })
  }, [doc, yElements])

  // Images: upload anything Excalidraw put in `files` that the Y.Doc lacks, then
  // share only the resulting attachment URL. `uploadingRef` is one-shot per file id:
  // onChange fires on every pointer move, so a failed upload must not be retried
  // there or one rejected image becomes an upload storm.
  const uploadingRef = useRef(new Set<string>())
  const uploadNewFiles = useCallback(
    (files: BinaryFiles) => {
      if (!canEditRef.current) return
      for (const [id, file] of Object.entries(files)) {
        if (yFiles.has(id) || uploadingRef.current.has(id)) continue
        // Files we pulled back from the server are re-added as data URLs too, but
        // they already have a yFiles entry, so only genuinely new ones get here.
        if (!file.dataURL?.startsWith('data:')) continue
        if (!UPLOADABLE_IMAGE_TYPES.has(file.mimeType)) {
          uploadingRef.current.add(id)
          toastError('Canvas images must be PNG, JPEG, GIF, WebP, or AVIF')
          continue
        }
        uploadingRef.current.add(id)
        void (async () => {
          try {
            const blob = await (await fetch(file.dataURL)).blob()
            const upload = new File([blob], `canvas-${id}`, { type: file.mimeType })
            const attachment = await api.uploadDocImage(docId, upload)
            doc.transact(() => {
              yFiles.set(id, {
                id,
                url: attachment.url,
                mimeType: file.mimeType,
                created: file.created ?? Date.now(),
              })
            })
          } catch (error) {
            // Deliberately keep the id marked: the image stays local-only until
            // the author re-adds it, rather than re-POSTing on every frame.
            toastError(error instanceof Error ? error.message : 'Image upload failed')
          }
        })()
      }
    },
    [doc, docId, yFiles],
  )

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], _appState: AppState, files: BinaryFiles) => {
      pendingRef.current = elements
      if (!flushTimer.current) flushTimer.current = setTimeout(flush, FLUSH_MS)
      uploadNewFiles(files)
    },
    [flush, uploadNewFiles],
  )

  useEffect(
    () => () => {
      if (flushTimer.current) clearTimeout(flushTimer.current)
    },
    [],
  )

  // ---- YJS -> LOCAL ------------------------------------------------------
  useEffect(() => {
    if (!ready) return
    const onRemote = (_event: Y.YMapEvent<OrderedExcalidrawElement>, tx: Y.Transaction) => {
      // tx.local is true for our own doc.transact above; server updates arrive
      // through Y.applyUpdate inside the provider and are non-local.
      if (tx.local) return
      const editor = apiRef.current
      if (!editor) return
      const remote = inSceneOrder([...yElements.values()])
      for (const element of remote) seenRef.current.set(element.id, element.versionNonce)
      const reconciled = reconcileElements(
        editor.getSceneElementsIncludingDeleted(),
        remote as RemoteExcalidrawElement[],
        editor.getAppState(),
      )
      editor.updateScene({ elements: reconciled, captureUpdate: CaptureUpdateAction.NEVER })
    }
    yElements.observe(onRemote)
    return () => yElements.unobserve(onRemote)
  }, [ready, yElements])

  // ---- IMAGES: pull bytes for references we don't have yet ---------------
  const pullFilesRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!ready) return
    const requested = new Set<string>()
    let cancelled = false

    const pull = () => {
      const editor = apiRef.current
      if (!editor) return
      const present = editor.getFiles()
      yFiles.forEach((ref, id) => {
        if (requested.has(id) || present[id]) return
        requested.add(id)
        void fetchAttachmentBlob(ref.url)
          .then(blobToDataUrl)
          .then((dataURL) => {
            if (cancelled) return
            apiRef.current?.addFiles([
              {
                id: id as never,
                mimeType: ref.mimeType as never,
                dataURL: dataURL as never,
                created: ref.created,
              },
            ])
          })
          .catch(() => {
            requested.delete(id)
          })
      })
    }

    pullFilesRef.current = pull
    yFiles.observe(pull)
    pull()
    return () => {
      cancelled = true
      pullFilesRef.current = () => {}
      yFiles.unobserve(pull)
    }
  }, [ready, yFiles])

  const setApi = useCallback((editor: ExcalidrawImperativeAPI) => {
    apiRef.current = editor
    // The editor mounts after the file effect ran, so kick a pull now.
    pullFilesRef.current()
  }, [])

  // ---- PRESENCE ----------------------------------------------------------
  const [peerCount, setPeerCount] = useState(0)

  const presenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onPointerUpdate = useCallback(
    (payload: {
      pointer: { x: number; y: number; tool: 'pointer' | 'laser' }
      button: 'down' | 'up'
    }) => {
      if (presenceTimer.current) return
      presenceTimer.current = setTimeout(() => {
        presenceTimer.current = null
        const state: PresenceState = {
          pointer: payload.pointer,
          button: payload.button,
          selectedElementIds: apiRef.current?.getAppState().selectedElementIds,
        }
        awareness.setLocalStateField('excalidrawPresence', state)
      }, FLUSH_MS)
    },
    [awareness],
  )

  useEffect(() => {
    if (!ready) return

    const applyPeers = () => {
      const collaborators = new Map<SocketId, Collaborator>()
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === doc.clientID) return
        const peer = state as {
          user?: { name: string; color: string }
          excalidrawPresence?: PresenceState | null
        }
        if (!peer.user && !peer.excalidrawPresence) return
        const color = peer.user?.color ?? '#8b8b8b'
        collaborators.set(String(clientId) as SocketId, {
          id: String(clientId),
          username: peer.user?.name ?? 'Someone',
          color: { background: color, stroke: color },
          pointer: peer.excalidrawPresence?.pointer,
          button: peer.excalidrawPresence?.button,
          selectedElementIds: peer.excalidrawPresence?.selectedElementIds,
        })
      })
      setPeerCount(collaborators.size)
      apiRef.current?.updateScene({ collaborators })
    }

    // 'change' (content changed), not 'update' (also fires on clock heartbeats).
    awareness.on('change', applyPeers)
    applyPeers()
    return () => {
      awareness.off('change', applyPeers)
      if (presenceTimer.current) clearTimeout(presenceTimer.current)
      // Stop advertising our cursor; peers drop it on their next change event.
      awareness.setLocalStateField('excalidrawPresence', null)
    }
  }, [ready, awareness, doc, user.id])

  return { ready, initialData, peerCount, setApi, onChange, onPointerUpdate }
}
