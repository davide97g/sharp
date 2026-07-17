import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store'

// Mic control icon that comes alive while you speak: the mic glyph crossfades
// into a five-bar spectrum driven by real mic input (VoiceClient's analyser).
// Bars are laid out symmetrically — low band in the middle (speech
// fundamentals), mids beside it, highs at the edges — so vowels swell the
// center and consonants flicker the sides.

const BAR_COUNT = 5
const BAND_COUNT = 3
const BAR_BAND = [2, 1, 0, 1, 2]
const REST = 0.22 // bar height fraction at silence — resting dots
const ATTACK = 0.5
const RELEASE = 0.16

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

export function MicActivityIcon({ muted, size = 16 }: { muted: boolean; size?: number }) {
  const client = useStore((s) => s.voice.client)
  const speakingLocal = useStore((s) =>
    Boolean(s.myConnId && s.voice.speaking[s.myConnId]),
  )
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [reducedMotion] = useState(prefersReducedMotion)
  const live = !muted && speakingLocal && !reducedMotion && Boolean(client)

  useEffect(() => {
    if (!live || !client) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Schedule on the canvas's own window: inside the Document PiP window the
    // main tab may be hidden, which throttles the main window's rAF.
    const win = canvas.ownerDocument.defaultView ?? window
    const dpr = win.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const color = win.getComputedStyle(canvas).color
    const barW = canvas.width / (BAR_COUNT + (BAR_COUNT - 1) * 0.75)
    const gap = barW * 0.75
    const radius = barW / 2
    const bands = new Float32Array(BAND_COUNT)
    const heights = new Float32Array(BAR_COUNT).fill(REST)
    let frame = 0

    const draw = () => {
      client.getLocalSpectrum(bands)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = color
      for (let i = 0; i < BAR_COUNT; i++) {
        const level = Math.min(1, Math.sqrt(bands[BAR_BAND[i]]) * 1.25)
        const target = REST + (1 - REST) * level
        heights[i] += (target - heights[i]) * (target > heights[i] ? ATTACK : RELEASE)
        const h = Math.max(barW, heights[i] * canvas.height)
        const x = i * (barW + gap)
        const y = (canvas.height - h) / 2
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, barW, h, radius)
        else ctx.rect(x, y, barW, h)
        ctx.fill()
      }
      frame = win.requestAnimationFrame(draw)
    }
    frame = win.requestAnimationFrame(draw)
    return () => win.cancelAnimationFrame(frame)
  }, [live, client, size])

  return (
    <span
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <MicGlyph
        off={muted}
        size={size}
        className={`transition-[opacity,transform] duration-150 ${
          live ? 'scale-75 opacity-0' : 'scale-100 opacity-100'
        }`}
      />
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 transition-[opacity,transform] duration-150 ${
          live ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
        }`}
        style={{ width: size, height: size }}
      />
    </span>
  )
}

function MicGlyph({
  off,
  size,
  className,
}: {
  off: boolean
  size: number
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v5" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  )
}
