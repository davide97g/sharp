// Hand-rolled pointer-based drag & drop for the board (house pattern — no
// @dnd-kit). Handles two independent gestures:
//
//   • dragging a card between/within columns  → single moveCard() on drop
//   • dragging a column header horizontally    → moveOption() reorder on drop
//
// A 5px threshold guards the start so a plain click still opens the card panel.
// Rects are measured on drag start and re-read on scroll via the registered
// element maps. Everything is inert when `canEdit` is false. rAF auto-scrolls
// the horizontal strip near its edges.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import * as Y from 'yjs'
import type { BoardCardData } from '../../lib/boardDoc'
import { moveCard, moveOption } from '../../lib/boardDoc'
import { between } from '../../lib/fracIndex'

export const NO_STATUS = '__none__'

export type BoardColumnData = {
  key: string // optionId, or NO_STATUS for the synthetic uncategorized column
  optionId: string | null
  label: string
  color: string
  cards: BoardCardData[]
}

export type CardGhost = { cardId: string; x: number; y: number; w: number }
export type ColGhost = { x: number; y: number; width: number; label: string; color: string }
export type CardDrop = { colKey: string; index: number }

const THRESHOLD = 5 // px pointer travel before a drag actually begins
const EDGE = 72 // px from a strip edge where auto-scroll kicks in
const MAX_SCROLL = 22 // px per frame at the very edge

type CardSession = {
  kind: 'card'
  cardId: string
  pointerId: number
  startX: number
  startY: number
  offsetX: number // pointer offset within the card at grab time
  offsetY: number
  w: number
  active: boolean
}

type ColSession = {
  kind: 'column'
  optionId: string
  pointerId: number
  startX: number
  width: number
  offsetX: number
  label: string
  color: string
  active: boolean
}

export function useBoardDnd(opts: {
  ydoc: Y.Doc
  columns: BoardColumnData[]
  groupByPropertyId: string | null
  optionIds: Set<string>
  canEdit: boolean
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const { ydoc, scrollRef } = opts

  // Latest render values kept in refs so the drag handlers (created once) always
  // read fresh data without being torn down/rebuilt on every render.
  const columnsRef = useRef(opts.columns)
  columnsRef.current = opts.columns
  const groupByRef = useRef(opts.groupByPropertyId)
  groupByRef.current = opts.groupByPropertyId
  const optionIdsRef = useRef(opts.optionIds)
  optionIdsRef.current = opts.optionIds
  const canEditRef = useRef(opts.canEdit)
  canEditRef.current = opts.canEdit

  const columnEls = useRef(new Map<string, HTMLElement>())
  const cardEls = useRef(new Map<string, HTMLElement>())
  const session = useRef<CardSession | ColSession | null>(null)
  const suppressClick = useRef(false)

  const [dragCardId, setDragCardId] = useState<string | null>(null)
  const [cardGhost, setCardGhost] = useState<CardGhost | null>(null)
  const [cardDrop, setCardDrop] = useState<CardDrop | null>(null)
  const [dragOptionId, setDragOptionId] = useState<string | null>(null)
  const [colGhost, setColGhost] = useState<ColGhost | null>(null)
  const [colDrop, setColDrop] = useState<number | null>(null)

  // ---- auto-scroll -------------------------------------------------------
  const scrollDir = useRef(0) // px/frame, signed
  const rafId = useRef<number | null>(null)
  const stopAutoScroll = useCallback(() => {
    scrollDir.current = 0
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current)
      rafId.current = null
    }
  }, [])
  const tickScroll = useCallback(() => {
    const el = scrollRef.current
    if (el && scrollDir.current !== 0) el.scrollLeft += scrollDir.current
    rafId.current = scrollDir.current !== 0 ? requestAnimationFrame(tickScroll) : null
  }, [scrollRef])
  const updateAutoScroll = useCallback(
    (x: number) => {
      const el = scrollRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      let dir = 0
      if (x < r.left + EDGE) dir = -MAX_SCROLL * (1 - (x - r.left) / EDGE)
      else if (x > r.right - EDGE) dir = MAX_SCROLL * (1 - (r.right - x) / EDGE)
      scrollDir.current = dir
      if (dir !== 0 && rafId.current === null) rafId.current = requestAnimationFrame(tickScroll)
      else if (dir === 0) stopAutoScroll()
    },
    [scrollRef, tickScroll, stopAutoScroll],
  )

  const registerColumn = useCallback((key: string, el: HTMLElement | null) => {
    if (el) columnEls.current.set(key, el)
    else columnEls.current.delete(key)
  }, [])
  const registerCard = useCallback((id: string, el: HTMLElement | null) => {
    if (el) cardEls.current.set(id, el)
    else cardEls.current.delete(id)
  }, [])

  const consumeSuppressClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false
      return true
    }
    return false
  }, [])

  // ---- card drag geometry ------------------------------------------------
  const computeCardDrop = useCallback((x: number, y: number): CardDrop | null => {
    const cols = columnsRef.current
    if (cols.length === 0) return null
    // Column under the pointer-x (clamp to the nearest edge column otherwise).
    let target: BoardColumnData | null = null
    let bestDist = Infinity
    for (const col of cols) {
      const el = columnEls.current.get(col.key)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right) {
        target = col
        break
      }
      const dist = x < r.left ? r.left - x : x - r.right
      if (dist < bestDist) {
        bestDist = dist
        target = col
      }
    }
    if (!target) return null
    // Index by card midpoints, skipping the dragged card itself.
    const s = session.current
    const dragged = s && s.kind === 'card' ? s.cardId : null
    let index = 0
    for (const card of target.cards) {
      if (card.id === dragged) continue
      const el = cardEls.current.get(card.id)
      if (!el) {
        index++
        continue
      }
      const r = el.getBoundingClientRect()
      if (y > r.top + r.height / 2) index++
    }
    return { colKey: target.key, index }
  }, [])

  const computeColDrop = useCallback((x: number): number => {
    // Insertion index within the *option* columns only (No-status is fixed).
    const optCols = columnsRef.current.filter((c) => c.optionId !== null)
    let index = optCols.length
    for (let i = 0; i < optCols.length; i++) {
      const el = columnEls.current.get(optCols[i].key)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (x < r.left + r.width / 2) {
        index = i
        break
      }
    }
    return index
  }, [])

  const finishCardDrag = useCallback(
    (drop: CardDrop | null) => {
      const s = session.current
      if (!s || s.kind !== 'card' || !drop) return
      const col = columnsRef.current.find((c) => c.key === drop.colKey)
      if (!col) return
      const list = col.cards.filter((c) => c.id !== s.cardId)
      const prev = list[drop.index - 1]
      const next = list[drop.index]
      const order = between(prev?.order ?? null, next?.order ?? null)
      let statusOptionId = col.optionId
      // The target option may have vanished mid-drag (concurrent edit): fall
      // back to uncategorized rather than writing a dangling id.
      if (statusOptionId !== null && !optionIdsRef.current.has(statusOptionId)) {
        statusOptionId = null
      }
      moveCard(ydoc, s.cardId, order, statusOptionId)
    },
    [ydoc],
  )

  const finishColumnDrag = useCallback(
    (index: number | null) => {
      const s = session.current
      if (!s || s.kind !== 'column' || index === null) return
      const gid = groupByRef.current
      if (!gid) return
      const optCols = columnsRef.current.filter((c) => c.optionId !== null)
      const from = optCols.findIndex((c) => c.optionId === s.optionId)
      if (from === -1) return
      // moveOption removes first then inserts, so shift the target left when
      // moving an item rightward across its own slot.
      const dest = index > from ? index - 1 : index
      moveOption(ydoc, gid, s.optionId, dest)
    },
    [ydoc],
  )

  // ---- shared pointer handlers ------------------------------------------
  const endGesture = useCallback(() => {
    stopAutoScroll()
    setDragCardId(null)
    setCardGhost(null)
    setCardDrop(null)
    setDragOptionId(null)
    setColGhost(null)
    setColDrop(null)
    session.current = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopAutoScroll])

  const onMove = useCallback(
    (e: PointerEvent) => {
      const s = session.current
      if (!s) return
      if (s.kind === 'card') {
        if (!s.active) {
          if (Math.abs(e.clientX - s.startX) < THRESHOLD && Math.abs(e.clientY - s.startY) < THRESHOLD) return
          s.active = true
          suppressClick.current = true
          setDragCardId(s.cardId)
        }
        setCardGhost({ cardId: s.cardId, x: e.clientX - s.offsetX, y: e.clientY - s.offsetY, w: s.w })
        setCardDrop(computeCardDrop(e.clientX, e.clientY))
        updateAutoScroll(e.clientX)
      } else {
        if (!s.active) {
          if (Math.abs(e.clientX - s.startX) < THRESHOLD) return
          s.active = true
          suppressClick.current = true
          setDragOptionId(s.optionId)
        }
        setColGhost({ x: e.clientX - s.offsetX, y: e.clientY - 24, width: s.width, label: s.label, color: s.color })
        setColDrop(computeColDrop(e.clientX))
        updateAutoScroll(e.clientX)
      }
    },
    [computeCardDrop, computeColDrop, updateAutoScroll],
  )

  // Compute the drop target fresh from the release coordinates — never from
  // (possibly one frame stale) state — so the card lands exactly where shown.
  const onUp = useCallback(
    (e: PointerEvent) => {
      const s = session.current
      if (s?.active) {
        if (s.kind === 'card') finishCardDrag(computeCardDrop(e.clientX, e.clientY))
        else finishColumnDrag(computeColDrop(e.clientX))
      }
      endGesture()
    },
    [endGesture, finishCardDrag, finishColumnDrag, computeCardDrop, computeColDrop],
  )

  const onCancel = useCallback(() => {
    endGesture()
  }, [endGesture])

  const startCardDrag = useCallback(
    (e: ReactPointerEvent, cardId: string) => {
      if (!canEditRef.current || e.button !== 0) return
      const el = e.currentTarget as HTMLElement
      const r = el.getBoundingClientRect()
      session.current = {
        kind: 'card',
        cardId,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        offsetX: e.clientX - r.left,
        offsetY: e.clientY - r.top,
        w: r.width,
        active: false,
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [onMove, onUp, onCancel],
  )

  const startColumnDrag = useCallback(
    (e: ReactPointerEvent, optionId: string) => {
      if (!canEditRef.current || e.button !== 0) return
      const col = columnsRef.current.find((c) => c.optionId === optionId)
      if (!col) return
      const el = columnEls.current.get(col.key)
      const r = el?.getBoundingClientRect()
      session.current = {
        kind: 'column',
        optionId,
        pointerId: e.pointerId,
        startX: e.clientX,
        width: r?.width ?? 280,
        offsetX: r ? e.clientX - r.left : 0,
        label: col.label,
        color: col.color,
        active: false,
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onCancel)
    },
    [onMove, onUp, onCancel],
  )

  // Tidy up listeners + rAF if the hook unmounts mid-drag.
  useEffect(() => {
    return () => {
      stopAutoScroll()
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [onMove, onUp, onCancel, stopAutoScroll])

  return {
    registerColumn,
    registerCard,
    startCardDrag,
    startColumnDrag,
    consumeSuppressClick,
    dragCardId,
    cardGhost,
    cardDrop,
    dragOptionId,
    colGhost,
    colDrop,
  }
}
