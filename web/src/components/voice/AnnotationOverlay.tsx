import { useCallback, useEffect, useRef } from 'react'
import { annotations, DEFAULT_SIZE, type Point } from '../../lib/annotations'

// A transparent canvas laid over a shared-screen <video>. The video uses
// object-contain, so its content is letterboxed inside the element box; we
// compute that content box from videoWidth/videoHeight vs the element size and
// map both incoming pointer coords (-> normalized 0..1) and outgoing stroke
// coords (normalized -> px) through the same transform. Repaint is rAF-driven so
// the per-owner fade animates smoothly even with no new events.
export function AnnotationOverlay({
  videoRef,
  active,
  color,
  size = DEFAULT_SIZE,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>
  active: boolean
  color: string
  size?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef = useRef<number | null>(null)
  const drawingRef = useRef(false)

  // Latest props read inside stable pointer handlers.
  const activeRef = useRef(active)
  const colorRef = useRef(color)
  const sizeRef = useRef(size)
  activeRef.current = active
  colorRef.current = color
  sizeRef.current = size

  // Content-box geometry (element css px): letterbox offset + content size.
  const metrics = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return null
    const ew = canvas.clientWidth
    const eh = canvas.clientHeight
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!ew || !eh || !vw || !vh) return null
    const scale = Math.min(ew / vw, eh / vh)
    const cw = vw * scale
    const ch = vh * scale
    return { ew, eh, cw, ch, ox: (ew - cw) / 2, oy: (eh - ch) / 2 }
  }, [videoRef])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const ew = canvas.clientWidth
    const eh = canvas.clientHeight
    if (canvas.width !== Math.round(ew * dpr) || canvas.height !== Math.round(eh * dpr)) {
      canvas.width = Math.round(ew * dpr)
      canvas.height = Math.round(eh * dpr)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, ew, eh)

    const m = metrics()
    const strokes = annotations.getRenderState(Date.now())
    if (m) {
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      for (const stroke of strokes) {
        if (stroke.points.length === 0) continue
        const pts = stroke.points.map(
          ([nx, ny]) => [m.ox + nx * m.cw, m.oy + ny * m.ch] as [number, number],
        )
        ctx.globalAlpha = stroke.opacity
        ctx.strokeStyle = stroke.color
        ctx.lineWidth = Math.max(2, stroke.size * m.cw)
        ctx.beginPath()
        ctx.moveTo(pts[0][0], pts[0][1])
        if (pts.length === 1) {
          // A dot: tiny line so round caps render a filled circle.
          ctx.lineTo(pts[0][0] + 0.01, pts[0][1])
        } else {
          // Smooth: quadratic curves through the midpoints between samples.
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i][0] + pts[i + 1][0]) / 2
            const my = (pts[i][1] + pts[i + 1][1]) / 2
            ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my)
          }
          const last = pts[pts.length - 1]
          ctx.lineTo(last[0], last[1])
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // Keep animating while any stroke is alive (fade needs continuous frames).
    if (strokes.length > 0) rafRef.current = requestAnimationFrame(draw)
    else rafRef.current = null
  }, [metrics])

  const ensureLoop = useCallback(() => {
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(draw)
  }, [draw])

  // Repaint on engine changes, container resize, and intrinsic video-size changes.
  useEffect(() => {
    const unsub = annotations.subscribe(ensureLoop)
    ensureLoop()
    const canvas = canvasRef.current
    const video = videoRef.current
    const ro = new ResizeObserver(ensureLoop)
    if (canvas) ro.observe(canvas)
    const onResize = () => ensureLoop()
    video?.addEventListener('resize', onResize)
    return () => {
      unsub()
      ro.disconnect()
      video?.removeEventListener('resize', onResize)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [ensureLoop, videoRef])

  const toNormalized = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const canvas = canvasRef.current
      const video = videoRef.current
      if (!canvas || !video) return null
      const rect = canvas.getBoundingClientRect()
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!rect.width || !rect.height || !vw || !vh) return null
      const scale = Math.min(rect.width / vw, rect.height / vh)
      const cw = vw * scale
      const ch = vh * scale
      const ox = (rect.width - cw) / 2
      const oy = (rect.height - ch) / 2
      const nx = (clientX - rect.left - ox) / cw
      const ny = (clientY - rect.top - oy) / ch
      return [Math.min(1, Math.max(0, nx)), Math.min(1, Math.max(0, ny))]
    },
    [videoRef],
  )

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!activeRef.current) return
    const point = toNormalized(e.clientX, e.clientY)
    if (!point) return
    e.preventDefault()
    canvasRef.current?.setPointerCapture(e.pointerId)
    drawingRef.current = true
    annotations.beginLocalStroke(crypto.randomUUID(), colorRef.current, sizeRef.current, point)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    // Coalesced events recover sub-frame samples for smoother strokes.
    const raw =
      typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : []
    const events = raw.length > 0 ? raw : [e.nativeEvent]
    const points: Point[] = []
    for (const ev of events) {
      const point = toNormalized(ev.clientX, ev.clientY)
      if (point) points.push(point)
    }
    if (points.length > 0) annotations.appendLocalPoints(points)
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    drawingRef.current = false
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId)
    } catch {
      // capture may already be gone
    }
    annotations.endLocalStroke()
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 h-full w-full"
      style={{
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? 'crosshair' : 'default',
        touchAction: active ? 'none' : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    />
  )
}
