import { useEffect, useRef } from 'react'
import { useStore } from '../store'
import { activePack, type EventEffect } from '../lib/seasonal'

// The particle layer for seasonal packs, at `full` intensity only.
//
// One <canvas>, one rAF loop, `pointer-events: none`, paused whenever the tab
// is hidden. Everything else about a pack (accent retint, reaction set, copy)
// is plain data applied elsewhere; this file exists purely so snow can fall
// without costing anything when it is not falling.

type Particle = { x: number; y: number; vx: number; vy: number; r: number; a: number }

const SPECS: Record<
  EventEffect,
  { count: number; color: string; drift: number; fall: [number, number]; size: [number, number] }
> = {
  snow: { count: 60, color: '#ffffff', drift: 0.35, fall: [0.25, 0.85], size: [1.2, 3] },
  petals: { count: 34, color: '#ffb7d5', drift: 0.7, fall: [0.3, 0.8], size: [2, 4.5] },
  leaves: { count: 28, color: '#d98a3d', drift: 0.9, fall: [0.35, 0.95], size: [2.5, 5] },
  sparks: { count: 40, color: '#ff9c3d', drift: 0.2, fall: [-0.9, -0.25], size: [1, 2.4] },
  confetti: { count: 70, color: '', drift: 0.8, fall: [0.5, 1.4], size: [2, 4] },
}

const CONFETTI_COLORS = ['#ff5d8f', '#ffd166', '#5ec98c', '#6fa8f5', '#b58cf2']

export function SeasonalLayer() {
  const intensity = useStore((s) => s.ui.seasonal)
  const focusMode = useStore((s) => s.ui.focusMode)
  const motion = useStore((s) => s.ui.motion)
  // Subscribed, not just read, so pinning a pack from Settings starts the
  // weather immediately instead of on the next unrelated render.
  const preview = useStore((s) => s.seasonPreview)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const pack = activePack(undefined, preview)
  const effect = pack?.effect ?? null
  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const active = intensity === 'full' && !focusMode && motion > 0 && !reduced && !!effect

  useEffect(() => {
    if (!active || !effect) return
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const spec = SPECS[effect]
    let width = 0
    let height = 0
    let particles: Particle[] = []

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      width = window.innerWidth
      height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const spawn = (): Particle => ({
      x: Math.random() * width,
      // Upward effects (sparks) start at the bottom.
      y: spec.fall[0] < 0 ? height + Math.random() * 40 : -Math.random() * height,
      vx: (Math.random() - 0.5) * spec.drift,
      vy: spec.fall[0] + Math.random() * (spec.fall[1] - spec.fall[0]),
      r: spec.size[0] + Math.random() * (spec.size[1] - spec.size[0]),
      a: 0.35 + Math.random() * 0.5,
    })

    resize()
    particles = Array.from({ length: spec.count }, spawn)
    window.addEventListener('resize', resize)

    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      // Normalise to 60fps steps and scale by the motion slider, so the same
      // control that slows transitions slows the weather.
      const dt = Math.min(3, ((now - last) / 16.67) * motion)
      last = now
      ctx.clearRect(0, 0, width, height)
      particles.forEach((p, i) => {
        p.x += p.vx * dt
        p.y += p.vy * dt
        if (p.y > height + 10 || p.y < -10) Object.assign(p, spawn(), { y: p.vy > 0 ? -10 : height + 10 })
        if (p.x < -10) p.x = width + 10
        if (p.x > width + 10) p.x = -10
        ctx.globalAlpha = p.a
        ctx.fillStyle = spec.color || CONFETTI_COLORS[i % CONFETTI_COLORS.length]
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      })
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(frame)
    }
    const start = () => {
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const stop = () => cancelAnimationFrame(raf)

    // A hidden tab must not keep a rAF loop (and a GPU) busy.
    const onVisibility = () => (document.hidden ? stop() : start())
    document.addEventListener('visibilitychange', onVisibility)
    start()

    return () => {
      stop()
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, effect, motion])

  if (!active) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-(--z-lightbox)"
    />
  )
}
