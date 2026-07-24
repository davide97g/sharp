import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { SharpDocProvider, type DocConnStatus, type DocRoleByte } from '../../lib/docSync'
import { useStore } from '../../store'
import { readSnapshot, seedBoardIfEmpty, type BoardCardData } from '../../lib/boardDoc'
import { colorOf } from '../../lib/boardColors'
import { BoardColumn } from './BoardColumn'
import { BoardCard } from './BoardCard'
import { CardPanel } from './CardPanel'
import { CustomizePanel } from './CustomizePanel'
import { NO_STATUS, useBoardDnd, type BoardColumnData } from './useBoardDnd'

export type Peer = { clientId: number; name: string; color: string }

const noop = () => {}
const noopReg = () => {}
const noopSuppress = () => false

export function BoardEditorInner({
  docId,
  channelId,
  user,
  editable,
  customizeOpen,
  onCustomizeClose,
  onStatus,
  onPeers,
}: {
  docId: string
  channelId: string
  user: { name: string; color: string }
  editable: boolean
  customizeOpen: boolean
  onCustomizeClose: () => void
  onStatus: (status: DocConnStatus) => void
  onPeers: (peers: Peer[]) => void
}) {
  const [role, setRole] = useState<DocRoleByte>(editable ? 'editor' : 'viewer')
  const [status, setStatus] = useState<DocConnStatus>('connecting')
  const [version, setVersion] = useState(0)
  const [openCardId, setOpenCardId] = useState<string | null>(null)

  const members = useStore((s) => s.members[channelId])
  const loadMembers = useStore((s) => s.loadMembers)
  useEffect(() => {
    loadMembers(channelId)
  }, [channelId, loadMembers])

  // One Y.Doc + provider per mount (keyed by docId upstream). Lazily created via
  // a ref so StrictMode's double-render doesn't build two of everything.
  const holder = useRef<{ ydoc: Y.Doc; provider: SharpDocProvider } | null>(null)
  if (!holder.current) {
    const ydoc = new Y.Doc()
    holder.current = {
      ydoc,
      provider: new SharpDocProvider({
        docId,
        doc: ydoc,
        user,
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

  // Socket lifecycle: connect on mount, disconnect on cleanup. Teardown is
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

  // Re-render on any board change via a single version counter (boards are
  // small — no need for granular subscriptions).
  useEffect(() => {
    const board = ydoc.getMap('board')
    const cards = ydoc.getMap('cards')
    const bump = () => setVersion((v) => v + 1)
    board.observeDeep(bump)
    cards.observeDeep(bump)
    return () => {
      board.unobserveDeep(bump)
      cards.unobserveDeep(bump)
    }
  }, [ydoc])

  // Seed the default schema once, only after we've synced with the server (never
  // seed over authoritative state) and only if we may write.
  useEffect(() => {
    if (status === 'connected' && canEdit) seedBoardIfEmpty(ydoc)
  }, [status, canEdit, ydoc])

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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => readSnapshot(ydoc), [version, ydoc])

  // Group cards into columns: the group-by select's options are the columns (in
  // their stored order); cards whose value is missing/dangling fall into a
  // synthetic leftmost "No status" column shown only when non-empty.
  const { columns, optionIds } = useMemo(() => {
    const groupBy = snapshot.properties.find(
      (p) => p.id === snapshot.groupByPropertyId && p.type === 'select',
    )
    const options = groupBy?.options ?? []
    const ids = new Set(options.map((o) => o.id))
    const buckets = new Map<string, BoardCardData[]>()
    for (const o of options) buckets.set(o.id, [])
    const noStatus: BoardCardData[] = []
    const gid = snapshot.groupByPropertyId
    for (const card of snapshot.cards) {
      const val = gid ? card.values[gid] : undefined
      const optId = typeof val === 'string' ? val : undefined
      if (optId && ids.has(optId)) buckets.get(optId)!.push(card)
      else noStatus.push(card)
    }
    const sort = (arr: BoardCardData[]) =>
      arr.sort((a, b) =>
        a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
    const cols: BoardColumnData[] = []
    if (noStatus.length > 0)
      cols.push({ key: NO_STATUS, optionId: null, label: 'No status', color: 'gray', cards: sort(noStatus) })
    for (const o of options)
      cols.push({ key: o.id, optionId: o.id, label: o.label, color: o.color, cards: sort(buckets.get(o.id)!) })
    return { columns: cols, optionIds: ids }
  }, [snapshot])

  const scrollRef = useRef<HTMLDivElement>(null)
  const dnd = useBoardDnd({
    ydoc,
    columns,
    groupByPropertyId: snapshot.groupByPropertyId,
    optionIds,
    canEdit,
    scrollRef,
  })

  // Close the card panel if its card was deleted (locally or remotely).
  const openCard = openCardId ? snapshot.cards.find((c) => c.id === openCardId) : undefined
  useEffect(() => {
    if (openCardId && !openCard) setOpenCardId(null)
  }, [openCardId, openCard])

  const ghostCard = dnd.cardGhost ? snapshot.cards.find((c) => c.id === dnd.cardGhost!.cardId) : undefined

  // Interleave the column-reorder insertion line among the option columns.
  const strip: React.ReactNode[] = []
  const vline = (k: string) => (
    <div key={k} className="w-0.5 shrink-0 self-stretch rounded-full bg-[var(--color-accent)]" />
  )
  let optIdx = 0
  for (const col of columns) {
    const column = (
      <BoardColumn
        key={col.key}
        column={col}
        properties={snapshot.properties}
        members={members}
        ydoc={ydoc}
        groupByPropertyId={snapshot.groupByPropertyId}
        canEdit={canEdit}
        dropIndex={dnd.cardDrop?.colKey === col.key ? dnd.cardDrop.index : null}
        dnd={dnd}
        onOpenCard={setOpenCardId}
      />
    )
    if (col.optionId === null) {
      strip.push(column)
      continue
    }
    if (dnd.colDrop === optIdx) strip.push(vline(`vl-${optIdx}`))
    strip.push(column)
    optIdx++
  }
  if (dnd.colDrop === optIdx) strip.push(vline('vl-end'))

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} className="h-full overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-min items-start gap-3 px-4 pb-4 sm:px-6">
          {strip}
        </div>
      </div>

      {openCard && (
        <CardPanel
          card={openCard}
          properties={snapshot.properties}
          members={members}
          ydoc={ydoc}
          canEdit={canEdit}
          onClose={() => setOpenCardId(null)}
        />
      )}

      {customizeOpen && (
        <CustomizePanel
          ydoc={ydoc}
          properties={snapshot.properties}
          groupByPropertyId={snapshot.groupByPropertyId}
          onClose={onCustomizeClose}
        />
      )}

      {/* drag ghosts */}
      {dnd.cardGhost && ghostCard && (
        <div
          className="pointer-events-none fixed z-(--z-overlay) rounded-lg shadow-2xl"
          style={{
            left: dnd.cardGhost.x,
            top: dnd.cardGhost.y,
            width: dnd.cardGhost.w,
            transform: 'scale(1.02) rotate(1.5deg)',
            opacity: 0.92,
          }}
        >
          <BoardCard
            card={ghostCard}
            properties={snapshot.properties}
            groupByPropertyId={snapshot.groupByPropertyId}
            members={members}
            canEdit={false}
            dragging={false}
            onOpen={noop}
            onPointerDown={noop}
            consumeSuppressClick={noopSuppress}
            registerCard={noopReg}
          />
        </div>
      )}
      {dnd.colGhost && (
        <div
          className="pointer-events-none fixed z-(--z-overlay) rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-3 shadow-2xl"
          style={{ left: dnd.colGhost.x, top: dnd.colGhost.y, width: dnd.colGhost.width, opacity: 0.92 }}
        >
          <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold"
            style={{ backgroundColor: colorOf(dnd.colGhost.color).bg, color: colorOf(dnd.colGhost.color).fg }}
          >
            {dnd.colGhost.label || 'Untitled'}
          </span>
        </div>
      )}
    </div>
  )
}
