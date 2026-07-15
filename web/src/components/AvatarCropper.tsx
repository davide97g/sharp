import { useCallback, useEffect, useRef, useState } from 'react'

const VIEW = 256 // on-screen square viewport (px)
const OUT = 512 // exported square size (px)
const MAX_ZOOM = 4

// Interactive square cropper: drag to reposition, zoom to fit, export a square PNG.
export function AvatarCropper({
  file,
  onCancel,
  onDone,
  busy,
}: {
  file: File
  onCancel: () => void
  onDone: (blob: Blob) => void
  busy?: boolean
}) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // Load the picked file into an Image element.
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => setImg(im)
    im.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  // cover-fit base scale: the smaller image dimension exactly fills the viewport.
  const baseScale = img ? VIEW / Math.min(img.width, img.height) : 1
  const displayScale = baseScale * zoom

  // Clamp offset so the image always fully covers the square viewport.
  const clamp = useCallback(
    (o: { x: number; y: number }, dScale: number) => {
      if (!img) return o
      const w = img.width * dScale
      const h = img.height * dScale
      const minX = VIEW - w
      const minY = VIEW - h
      return {
        x: Math.min(0, Math.max(minX, o.x)),
        y: Math.min(0, Math.max(minY, o.y)),
      }
    },
    [img],
  )

  // Centre the image once it loads (and reset zoom).
  useEffect(() => {
    if (!img) return
    setZoom(1)
    const w = img.width * baseScale
    const h = img.height * baseScale
    setOffset({ x: (VIEW - w) / 2, y: (VIEW - h) / 2 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img])

  // Keep the viewport centre stable while zooming, then re-clamp.
  const prevScaleRef = useRef(displayScale)
  useEffect(() => {
    if (!img) return
    const prev = prevScaleRef.current
    if (prev !== displayScale) {
      const ratio = displayScale / prev
      setOffset((o) => clamp({ x: VIEW / 2 - (VIEW / 2 - o.x) * ratio, y: VIEW / 2 - (VIEW / 2 - o.y) * ratio }, displayScale))
      prevScaleRef.current = displayScale
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayScale])

  function onWheel(e: React.WheelEvent) {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z - e.deltaY * 0.002)))
  }

  function onPointerDown(e: React.PointerEvent) {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y }
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current
    if (!d) return
    setOffset(
      clamp({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) }, displayScale),
    )
  }
  function onPointerUp() {
    dragRef.current = null
  }

  function exportBlob() {
    if (!img) return
    const canvas = document.createElement('canvas')
    canvas.width = OUT
    canvas.height = OUT
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Map the viewport's source region in image space, then scale to OUT.
    const sx = -offset.x / displayScale
    const sy = -offset.y / displayScale
    const sSize = VIEW / displayScale
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUT, OUT)
    canvas.toBlob((blob) => blob && onDone(blob), 'image/png')
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative cursor-grab touch-none overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-ink)] active:cursor-grabbing"
        style={{ width: VIEW, height: VIEW }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {img && (
          <img
            src={img.src}
            alt=""
            draggable={false}
            className="max-w-none select-none"
            style={{
              width: img.width * displayScale,
              height: img.height * displayScale,
              transform: `translate(${offset.x}px, ${offset.y}px)`,
            }}
          />
        )}
        {/* soft-rounded mask hint */}
        <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/10" />
      </div>

      <div className="flex w-full items-center gap-2">
        <span className="text-xs text-[var(--color-text-faint)]">Zoom</span>
        <input
          type="range"
          min={1}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-[var(--color-accent)]"
        />
      </div>
      <p className="text-[11px] text-[var(--color-text-faint)]">Drag to reposition · scroll or slider to zoom</p>

      <div className="flex w-full items-center justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={exportBlob}
          disabled={!img || busy}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save photo'}
        </button>
      </div>
    </div>
  )
}
