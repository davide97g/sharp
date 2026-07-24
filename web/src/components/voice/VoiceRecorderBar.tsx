import { useEffect, useRef, useState } from 'react'
import type { VoiceRecorder } from '../../lib/audioRecording'
import { TrashIcon } from '../../ui'

// Recording UI shown inside the composer while capturing a voice message: a red
// pulsing dot, the same five-bar spectrum visual as MicActivityIcon (driven by
// the recorder's own AnalyserNode), an elapsed timer, and delete/stop controls.

const BAR_COUNT = 5
const BAND_COUNT = 3
const BAR_BAND = [2, 1, 0, 1, 2]
const REST = 0.22
const ATTACK = 0.5
const RELEASE = 0.16
const CANVAS_W = 96
const CANVAS_H = 24

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function Waveform({ recorder }: { recorder: VoiceRecorder }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [reducedMotion] = useState(prefersReducedMotion)

  useEffect(() => {
    if (reducedMotion) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(CANVAS_W * dpr)
    canvas.height = Math.round(CANVAS_H * dpr)
    const color = window.getComputedStyle(canvas).color
    const barW = canvas.width / (BAR_COUNT + (BAR_COUNT - 1) * 0.75)
    const gap = barW * 0.75
    const radius = barW / 2
    const bands = new Float32Array(BAND_COUNT)
    const heights = new Float32Array(BAR_COUNT).fill(REST)
    let frame = 0

    const draw = () => {
      recorder.getSpectrum(bands)
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
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [recorder, reducedMotion])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: CANVAS_W, height: CANVAS_H }}
      className="text-[var(--color-accent)]"
      aria-hidden
    />
  )
}

export function VoiceRecorderBar({
  recorder,
  elapsedMs,
  onStop,
  onCancel,
}: {
  recorder: VoiceRecorder
  elapsedMs: number
  onStop: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
        <span className="voice-rec-dot h-2.5 w-2.5 rounded-full bg-danger" />
        Recording
      </span>
      <Waveform recorder={recorder} />
      <span className="tabular-nums text-sm text-[var(--color-text-dim)]">{fmtElapsed(elapsedMs)}</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          title="Discard recording"
          aria-label="Discard recording"
          className="flex h-11 w-11 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] md:h-9 md:w-9"
        >
          <TrashIcon size={18} />
        </button>
        <button
          type="button"
          onClick={onStop}
          title="Stop recording"
          aria-label="Stop recording"
          className="flex h-11 items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] md:h-9"
        >
          <StopGlyph />
          Stop
        </button>
      </div>
    </div>
  )
}

function StopGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}
