// Screen-share annotation ("pen") engine.
//
// Why this lives OUTSIDE the zustand store: annotation points arrive at pointer
// cadence (plus ~40ms outgoing flushes) — routing them through the store would
// re-render the whole React tree on every point. Instead the live strokes are
// held here in module state; the canvas overlay subscribes and repaints via rAF.
// Only coarse flags (annotationsAllowed / annotating) live in the store.

export type Point = [number, number] // normalized 0..1, relative to video content box

export type Stroke = {
  strokeId: string
  connId: string
  color: string
  size: number // brush width as a fraction of video width
  points: Point[]
}

export type RenderStroke = Stroke & { opacity: number }

// Server -> client relay of an annotate event (mirrors VoiceAnnotatePayload).
export type RemoteAnnotate = {
  conn_id: string
  color: string
  stroke_id: string
  kind: 'start' | 'points' | 'end'
  points: [number, number][]
  size?: number
}

// Outgoing batch handed to the store's ws.send wrapper.
export type OutgoingAnnotate = {
  stroke_id: string
  kind: 'start' | 'points' | 'end'
  points: [number, number][]
  size?: number
}

type SendFn = (payload: OutgoingAnnotate) => void

// Fade math (see spec): once an owner is idle, opacity = 1 - elapsed/5000 across
// ALL of that owner's strokes; removed at 0. Any activity resets to full opacity.
const FADE_MS = 5000
const FLUSH_MS = 40
const MAX_POINTS = 128 // server caps points per event at 128 pairs
export const DEFAULT_SIZE = 0.004

class AnnotationEngine {
  private strokes = new Map<string, Stroke>() // strokeId -> stroke
  private lastActivityAt = new Map<string, number>() // connId -> Date.now() ms
  private listeners = new Set<() => void>()

  private send: SendFn | null = null
  private myConnId: string | null = null

  // Outgoing batching for the in-progress local stroke.
  private localStrokeId: string | null = null
  private pending: Point[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  /** Wire up the outgoing send and this connection's id (called on join). */
  setSend(send: SendFn | null, myConnId: string | null): void {
    this.send = send
    this.myConnId = myConnId
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private touch(connId: string): void {
    this.lastActivityAt.set(connId, Date.now())
  }

  // --- local drawing ---

  beginLocalStroke(strokeId: string, color: string, size: number, point: Point): void {
    const connId = this.myConnId ?? 'local'
    this.localStrokeId = strokeId
    this.strokes.set(strokeId, { strokeId, connId, color, size, points: [point] })
    this.touch(connId)
    this.send?.({ stroke_id: strokeId, kind: 'start', points: [point], size })
    this.notify()
  }

  appendLocalPoints(points: Point[]): void {
    if (!this.localStrokeId || points.length === 0) return
    const stroke = this.strokes.get(this.localStrokeId)
    if (stroke) stroke.points.push(...points)
    this.pending.push(...points)
    this.touch(this.myConnId ?? 'local')
    this.scheduleFlush()
    this.notify()
  }

  endLocalStroke(): void {
    if (!this.localStrokeId) return
    this.flush()
    this.send?.({ stroke_id: this.localStrokeId, kind: 'end', points: [] })
    this.touch(this.myConnId ?? 'local')
    this.localStrokeId = null
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.localStrokeId || this.pending.length === 0 || !this.send) {
      this.pending = []
      return
    }
    const strokeId = this.localStrokeId
    // Chunk into <=128-pair events per the wire contract.
    for (let i = 0; i < this.pending.length; i += MAX_POINTS) {
      this.send({
        stroke_id: strokeId,
        kind: 'points',
        points: this.pending.slice(i, i + MAX_POINTS),
      })
    }
    this.pending = []
  }

  // --- remote events ---

  applyRemote(event: RemoteAnnotate): void {
    // Our own events are echoed locally already — ignore the relay.
    if (event.conn_id === this.myConnId) return
    this.touch(event.conn_id)
    if (event.kind === 'start') {
      this.strokes.set(event.stroke_id, {
        strokeId: event.stroke_id,
        connId: event.conn_id,
        color: event.color,
        size: event.size ?? DEFAULT_SIZE,
        points: event.points.map((p) => [p[0], p[1]] as Point),
      })
    } else {
      let stroke = this.strokes.get(event.stroke_id)
      if (!stroke) {
        // Defensive: points/end without a start (e.g. joined mid-stroke).
        stroke = {
          strokeId: event.stroke_id,
          connId: event.conn_id,
          color: event.color,
          size: event.size ?? DEFAULT_SIZE,
          points: [],
        }
        this.strokes.set(event.stroke_id, stroke)
      }
      for (const p of event.points) stroke.points.push([p[0], p[1]])
    }
    this.notify()
  }

  clearAll(): void {
    this.strokes.clear()
    this.notify()
  }

  clearConn(connId: string): void {
    for (const [id, stroke] of this.strokes) {
      if (stroke.connId === connId) this.strokes.delete(id)
    }
    this.lastActivityAt.delete(connId)
    this.notify()
  }

  /** Full teardown — call on leaving/joining a call. */
  reset(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.strokes.clear()
    this.lastActivityAt.clear()
    this.pending = []
    this.localStrokeId = null
    this.notify()
  }

  /**
   * Strokes with per-owner fade opacity for `now` (ms). Fully-faded strokes are
   * purged as a side effect so the store stays bounded.
   */
  getRenderState(now: number): RenderStroke[] {
    const out: RenderStroke[] = []
    for (const [id, stroke] of this.strokes) {
      const last = this.lastActivityAt.get(stroke.connId) ?? 0
      const opacity = Math.max(0, 1 - (now - last) / FADE_MS)
      if (opacity <= 0) {
        this.strokes.delete(id)
        continue
      }
      out.push({ ...stroke, opacity })
    }
    return out
  }
}

export const annotations = new AnnotationEngine()
