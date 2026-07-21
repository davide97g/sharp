// Pointer-based drag & drop for the task board — a trimmed cousin of
// board/useBoardDnd (cards only; workflow-state columns are not draggable in
// v1). On drop it computes the fractional index between neighbours and hands
// (taskId, stateId, sortOrder) to the caller, which PATCHes optimistically.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'
import { between } from '../../lib/fracIndex'
import type { Task, TaskState } from '../../lib/types'

export type TaskColumnData = { state: TaskState; tasks: Task[] }
export type TaskGhost = { taskId: string; x: number; y: number; w: number }
export type TaskDrop = { stateId: string; index: number }

const THRESHOLD = 5
const EDGE = 72
const MAX_SCROLL = 22

type Session = {
  taskId: string
  pointerId: number
  startX: number
  startY: number
  offsetX: number
  offsetY: number
  w: number
  active: boolean
}

export function useTaskDnd(opts: {
  columns: TaskColumnData[]
  canEdit: boolean
  scrollRef: RefObject<HTMLDivElement | null>
  onDrop: (taskId: string, stateId: string, sortOrder: string) => void
}) {
  const { scrollRef } = opts
  const columnsRef = useRef(opts.columns)
  columnsRef.current = opts.columns
  const canEditRef = useRef(opts.canEdit)
  canEditRef.current = opts.canEdit
  const onDropRef = useRef(opts.onDrop)
  onDropRef.current = opts.onDrop

  const columnEls = useRef(new Map<string, HTMLElement>())
  const cardEls = useRef(new Map<string, HTMLElement>())
  const session = useRef<Session | null>(null)
  const suppressClick = useRef(false)

  const [dragTaskId, setDragTaskId] = useState<string | null>(null)
  const [ghost, setGhost] = useState<TaskGhost | null>(null)
  const [drop, setDrop] = useState<TaskDrop | null>(null)

  const scrollDir = useRef(0)
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

  const registerColumn = useCallback((stateId: string, el: HTMLElement | null) => {
    if (el) columnEls.current.set(stateId, el)
    else columnEls.current.delete(stateId)
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

  const computeDrop = useCallback((x: number, y: number): TaskDrop | null => {
    const cols = columnsRef.current
    if (cols.length === 0) return null
    let target: TaskColumnData | null = null
    let bestDist = Infinity
    for (const col of cols) {
      const el = columnEls.current.get(col.state.id)
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
    const dragged = session.current?.taskId ?? null
    let index = 0
    for (const task of target.tasks) {
      if (task.id === dragged) continue
      const el = cardEls.current.get(task.id)
      if (!el) {
        index++
        continue
      }
      const r = el.getBoundingClientRect()
      if (y > r.top + r.height / 2) index++
    }
    return { stateId: target.state.id, index }
  }, [])

  const finishDrag = useCallback((dropAt: TaskDrop | null) => {
    const s = session.current
    if (!s || !dropAt) return
    const col = columnsRef.current.find((c) => c.state.id === dropAt.stateId)
    if (!col) return
    const list = col.tasks.filter((t) => t.id !== s.taskId)
    const prev = list[dropAt.index - 1]
    const next = list[dropAt.index]
    const order = between(prev?.sort_order ?? null, next?.sort_order ?? null)
    onDropRef.current(s.taskId, dropAt.stateId, order)
  }, [])

  const endGesture = useCallback(() => {
    stopAutoScroll()
    setDragTaskId(null)
    setGhost(null)
    setDrop(null)
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
      if (!s.active) {
        if (Math.abs(e.clientX - s.startX) < THRESHOLD && Math.abs(e.clientY - s.startY) < THRESHOLD)
          return
        s.active = true
        suppressClick.current = true
        setDragTaskId(s.taskId)
      }
      setGhost({ taskId: s.taskId, x: e.clientX - s.offsetX, y: e.clientY - s.offsetY, w: s.w })
      setDrop(computeDrop(e.clientX, e.clientY))
      updateAutoScroll(e.clientX)
    },
    [computeDrop, updateAutoScroll],
  )

  const onUp = useCallback(
    (e: PointerEvent) => {
      const s = session.current
      if (s?.active) finishDrag(computeDrop(e.clientX, e.clientY))
      endGesture()
    },
    [endGesture, finishDrag, computeDrop],
  )

  const onCancel = useCallback(() => endGesture(), [endGesture])

  const startDrag = useCallback(
    (e: ReactPointerEvent, taskId: string) => {
      if (!canEditRef.current || e.button !== 0) return
      const el = e.currentTarget as HTMLElement
      const r = el.getBoundingClientRect()
      session.current = {
        taskId,
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
    startDrag,
    consumeSuppressClick,
    dragTaskId,
    ghost,
    drop,
  }
}
