// Binds a tldraw v5 TLStore to a Y.Doc + y-protocols Awareness that we already
// own (SharpDocProvider). No @tldraw/sync. Verified against tldraw@5.2.4.
//
//   const st = useYjsTldrawStore({ doc: provider.doc, awareness: provider.awareness,
//                                  user, synced: docStatus === 'connected' })
//   return <Tldraw store={st} assetUrls={assetUrls} />
//
// Design notes (why it is written this way):
//  - Only DOCUMENT-scope records go into Yjs (via store.serialize('document')), so
//    each client keeps its own camera/selection; session/presence records stay local.
//  - tldraw -> Yjs writes use a plain doc.transact (null origin) so SharpDocProvider
//    forwards them to the server (it only skips origin === the provider itself).
//  - Yjs -> tldraw applies inside store.mergeRemoteChanges (tagged 'remote'), and the
//    tldraw->Yjs listener is scoped to source:'user', so there is no echo loop.
//  - The `synced` gate prevents seeding default records over authoritative server state.
import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import {
  computed,
  createPresenceStateDerivation,
  createTLStore,
  defaultBindingUtils,
  defaultShapeUtils,
  InstancePresenceRecordType,
  react,
  UserRecordType,
  type TLAnyBindingUtilConstructor,
  type TLAnyShapeUtilConstructor,
  type TLInstancePresence,
  type TLRecord,
  type TLStoreWithStatus,
  type TLUser,
} from 'tldraw'

export interface TldrawUser {
  /** Stable unique id (use the sharp user UUID). */
  id: string
  name: string
  /** Any CSS color; drives this user's cursor color. */
  color: string
}

export interface UseYjsTldrawStoreOptions {
  /** The Y.Doc owned by SharpDocProvider. */
  doc: Y.Doc
  /** The y-protocols Awareness exposed by SharpDocProvider. */
  awareness: Awareness
  /** Current user, for multiplayer presence. */
  user: TldrawUser
  /**
   * Pass `true` once the provider has completed its FIRST server sync (i.e.
   * SharpDocProvider status has reached 'connected'). Gates the initial
   * hydrate/seed so we never seed default records over authoritative server
   * state. Internally sticky: once true it stays true across reconnects.
   */
  synced?: boolean
  /** Extra custom shape utils, appended to tldraw's defaults. */
  shapeUtils?: readonly TLAnyShapeUtilConstructor[]
  /** Extra custom binding utils, appended to tldraw's defaults. */
  bindingUtils?: readonly TLAnyBindingUtilConstructor[]
  /** Y.Map key under which the tldraw document records live. Default 'tldraw'. */
  mapKey?: string
}

export function useYjsTldrawStore(
  options: UseYjsTldrawStoreOptions,
): TLStoreWithStatus {
  const {
    doc,
    awareness,
    user,
    synced = true,
    shapeUtils: extraShapeUtils,
    bindingUtils: extraBindingUtils,
    mapKey = 'tldraw',
  } = options

  // Create the store exactly once. Build its schema from the SAME utils you
  // pass to <Tldraw/>. Defaults give geo/draw/arrow/etc. + arrow bindings.
  const [store] = useState(() =>
    createTLStore({
      shapeUtils: [...defaultShapeUtils, ...(extraShapeUtils ?? [])],
      bindingUtils: [...defaultBindingUtils, ...(extraBindingUtils ?? [])],
    }),
  )

  // Sticky "ready": flips true the first time `synced` is true, then stays true
  // so a transient reconnect never triggers a destructive re-hydrate.
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (synced) setReady(true)
  }, [synced])

  const [status, setStatus] = useState<TLStoreWithStatus>({ status: 'loading' })

  // ---- DOCUMENT: hydrate + two-way sync (runs once, when ready) ----------
  useEffect(() => {
    if (!ready) {
      setStatus({ status: 'loading' })
      return
    }

    const yRecords = doc.getMap<TLRecord>(mapKey)
    const unsubs: Array<() => void> = []

    // Only DOCUMENT-scope records live in Yjs; session/presence stay local so
    // each client keeps its own viewport. serialize('document') filters scope.
    if (yRecords.size > 0) {
      // Server doc is authoritative: mirror it in WITHOUT clearing session
      // records (no store.clear()). Remove any local doc records Yjs lacks.
      store.mergeRemoteChanges(() => {
        const incoming = [...yRecords.values()]
        const incomingIds = new Set<string>(incoming.map((r) => r.id))
        const stale = (
          Object.keys(store.serialize('document')) as TLRecord['id'][]
        ).filter((id) => !incomingIds.has(id))
        if (stale.length) store.remove(stale)
        if (incoming.length) store.put(incoming)
      })
    } else {
      // Empty doc: seed Yjs (and the server) with our default doc records only.
      doc.transact(() => {
        for (const record of Object.values(store.serialize('document'))) {
          yRecords.set(record.id, record)
        }
      })
    }

    // tldraw -> Yjs. source:'user' skips our own mergeRemoteChanges writes, so
    // there is no echo. Plain doc.transact (null origin) => SharpDocProvider
    // forwards it to the server (it only skips origin === the provider itself).
    unsubs.push(
      store.listen(
        ({ changes }) => {
          doc.transact(() => {
            for (const record of Object.values(changes.added)) {
              yRecords.set(record.id, record)
            }
            for (const [, record] of Object.values(changes.updated)) {
              yRecords.set(record.id, record)
            }
            for (const record of Object.values(changes.removed)) {
              yRecords.delete(record.id)
            }
          })
        },
        { source: 'user', scope: 'document' },
      ),
    )

    // Yjs -> tldraw. tx.local is false for server updates applied via
    // Y.applyUpdate inside the provider, true for our doc.transact above.
    const onYChange = (event: Y.YMapEvent<TLRecord>, tx: Y.Transaction) => {
      if (tx.local) return
      const toPut: TLRecord[] = []
      const toRemove: TLRecord['id'][] = []
      event.changes.keys.forEach((change, id) => {
        if (change.action === 'delete') {
          toRemove.push(id as TLRecord['id'])
        } else {
          const record = yRecords.get(id)
          if (record) toPut.push(record)
        }
      })
      store.mergeRemoteChanges(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })
    }
    yRecords.observe(onYChange)
    unsubs.push(() => yRecords.unobserve(onYChange))

    setStatus({ store, status: 'synced-remote', connectionStatus: 'online' })

    return () => {
      for (const fn of unsubs) fn()
    }
  }, [ready, store, doc, mapKey])

  // ---- PRESENCE: multiplayer cursors over Awareness ----------------------
  useEffect(() => {
    if (!ready) return

    const unsubs: Array<() => void> = []

    // One presence record per Yjs client; clientID === the awareness key.
    const presenceId = InstancePresenceRecordType.createId(String(doc.clientID))

    const $user = computed<TLUser | null>('tldraw-presence-user', () =>
      UserRecordType.create({
        id: UserRecordType.createId(user.id),
        name: user.name,
        color: user.color,
      }),
    )

    // Reactive derivation of THIS client's presence (cursor/camera/selection).
    // v5 API: 2nd arg is an OPTIONS object { instanceId }, not a bare id.
    const $presence = createPresenceStateDerivation($user, {
      instanceId: presenceId,
    })(store)

    // Publish under the 'presence' field. SharpDocProvider already forwards all
    // awareness updates to the server, so no extra transport is needed. This
    // coexists with the provider's own 'user' field on the same client state.
    awareness.setLocalStateField('presence', $presence.get() ?? null)

    let raf = 0
    unsubs.push(
      react('publish tldraw presence', () => {
        const next = $presence.get() ?? null
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          awareness.setLocalStateField('presence', next)
        })
      }),
    )
    unsubs.push(() => cancelAnimationFrame(raf))

    // Apply peers' presence into the store as instance_presence records.
    const applyPeers = (update: {
      added: number[]
      updated: number[]
      removed: number[]
    }) => {
      const states = awareness.getStates() as Map<
        number,
        { presence?: TLInstancePresence | null }
      >
      const toPut: TLInstancePresence[] = []
      const toRemove: TLInstancePresence['id'][] = []

      for (const clientId of [...update.added, ...update.updated]) {
        const presence = states.get(clientId)?.presence
        if (presence && presence.id !== presenceId) {
          toPut.push(presence)
        } else if (!presence) {
          toRemove.push(InstancePresenceRecordType.createId(String(clientId)))
        }
      }
      for (const clientId of update.removed) {
        toRemove.push(InstancePresenceRecordType.createId(String(clientId)))
      }

      store.mergeRemoteChanges(() => {
        if (toRemove.length) store.remove(toRemove)
        if (toPut.length) store.put(toPut)
      })
    }

    // 'change' (content changed), not 'update' (also fires on clock heartbeats).
    awareness.on('change', applyPeers)
    unsubs.push(() => awareness.off('change', applyPeers))

    // Seed cursors for peers already connected at mount.
    applyPeers({
      added: [...awareness.getStates().keys()],
      updated: [],
      removed: [],
    })

    return () => {
      for (const fn of unsubs) fn()
      // Stop advertising our cursor; peers drop it on their next change event.
      awareness.setLocalStateField('presence', null)
    }
  }, [ready, store, doc, awareness, user.id, user.name, user.color])

  return status
}
