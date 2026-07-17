// Google-Meet-style camera background blur, fully self-hosted (no CDN). The
// MediaPipe selfie segmenter + its wasm fileset live under /public/mediapipe and
// are loaded lazily — this module (and the ~11MB wasm) is only imported the first
// time a user turns blur on, keeping the main bundle lean like the tldraw editor.
//
// The processor takes the raw camera track, runs a per-frame segmentation, and
// composites the sharp person over a blurred copy of the frame onto a canvas whose
// captureStream() output track is what actually gets published to peers.
import type { ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision'

// Absolute asset paths (served from origin root, like the service worker). The
// wasm loader resolves sibling files relative to this base itself.
const WASM_BASE = new URL('/mediapipe/wasm', window.location.origin).toString()
const MODEL_URL = new URL('/mediapipe/selfie_segmenter.tflite', window.location.origin).toString()

// Output canvas capture frame rate — aligned with the camera constraints in
// voice.ts (ideal 20, max 24).
const OUTPUT_FPS = 24
const BLUR_PX = 12
// Draw the blurred backdrop slightly larger than the frame so the blur's edge
// bleed (transparent fringe) never shows as letterboxing at the borders.
const BACKDROP_SCALE = 1.05

type VideoFrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

async function createSegmenter(): Promise<ImageSegmenter> {
  const vision = await import('@mediapipe/tasks-vision')
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE)
  const build = (delegate: 'GPU' | 'CPU') =>
    vision.ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    })
  try {
    return await build('GPU')
  } catch (error) {
    console.warn('Background blur: GPU delegate unavailable, falling back to CPU', error)
    return await build('CPU')
  }
}

export class BackgroundBlurProcessor {
  private segmenter: ImageSegmenter | null = null
  private video: HTMLVideoElement | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private maskCanvas: HTMLCanvasElement | null = null
  private maskCtx: CanvasRenderingContext2D | null = null
  private maskPixels: Uint8ClampedArray | null = null
  private maskDims = { width: 0, height: 0 }
  private output: MediaStream | null = null
  private rafHandle: number | null = null
  private rvfcHandle: number | null = null
  private stopped = false

  // Builds the pipeline and returns the processed (canvas) video track. Throws on
  // any init failure so the caller can fall back to the raw track.
  async start(rawTrack: MediaStreamTrack): Promise<MediaStreamTrack> {
    const settings = rawTrack.getSettings()
    const width = settings.width ?? 640
    const height = settings.height ?? 360

    this.segmenter = await createSegmenter()
    if (this.stopped) {
      this.dispose()
      throw new Error('Background blur was stopped during init.')
    }

    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([rawTrack])
    this.video = video
    await video.play()

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      this.dispose()
      throw new Error('Canvas 2D context is unavailable for background blur.')
    }
    this.canvas = canvas
    this.ctx = ctx

    const maskCanvas = document.createElement('canvas')
    const maskCtx = maskCanvas.getContext('2d')
    if (!maskCtx) {
      this.dispose()
      throw new Error('Canvas 2D context is unavailable for background blur.')
    }
    this.maskCanvas = maskCanvas
    this.maskCtx = maskCtx

    this.output = canvas.captureStream(OUTPUT_FPS)
    const outputTrack = this.output.getVideoTracks()[0]
    if (!outputTrack) {
      this.dispose()
      throw new Error('Could not capture the processed video stream.')
    }

    // Prime one frame so the returned track isn't blank on first paint.
    this.renderFrame()
    this.scheduleNext()
    return outputTrack
  }

  stop() {
    this.stopped = true
    this.dispose()
  }

  private scheduleNext() {
    if (this.stopped) return
    const video = this.video as VideoFrameCallbackVideo | null
    if (video?.requestVideoFrameCallback) {
      this.rvfcHandle = video.requestVideoFrameCallback(() => {
        this.renderFrame()
        this.scheduleNext()
      })
    } else {
      this.rafHandle = requestAnimationFrame(() => {
        this.renderFrame()
        this.scheduleNext()
      })
    }
  }

  private renderFrame() {
    const { segmenter, video, canvas, ctx } = this
    if (this.stopped || !segmenter || !video || !canvas || !ctx) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return

    // Cheap resolution-change handling: resize the output canvas to match the
    // live frame if the camera renegotiated its size.
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw
      canvas.height = vh
    }

    let result: ImageSegmenterResult
    try {
      result = segmenter.segmentForVideo(video, performance.now())
    } catch (error) {
      // A transient segmentation error shouldn't kill the call — just show the raw
      // frame this tick.
      console.warn('Background blur: segmentation frame failed', error)
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      return
    }

    const mask = result.confidenceMasks?.[0]
    if (!mask) {
      result.close?.()
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      return
    }

    try {
      this.paintMask(mask.getAsFloat32Array(), mask.width, mask.height)
    } finally {
      mask.close()
      result.categoryMask?.close()
    }

    const maskCanvas = this.maskCanvas
    if (!maskCanvas) return

    ctx.save()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    // 1. Lay down the person mask (alpha = person probability), scaled to frame.
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height)
    // 2. Keep the sharp video only where the mask is opaque (the person).
    ctx.globalCompositeOperation = 'source-in'
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    // 3. Fill everything behind with a blurred, slightly-enlarged copy so the blur
    //    edge bleed doesn't reveal transparent borders.
    ctx.globalCompositeOperation = 'destination-over'
    ctx.filter = `blur(${BLUR_PX}px)`
    const dw = canvas.width * BACKDROP_SCALE
    const dh = canvas.height * BACKDROP_SCALE
    ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh)
    ctx.restore()
  }

  // Renders the person-probability mask into maskCanvas as an alpha channel.
  private paintMask(data: Float32Array, width: number, height: number) {
    const maskCanvas = this.maskCanvas
    const maskCtx = this.maskCtx
    if (!maskCanvas || !maskCtx) return

    if (this.maskDims.width !== width || this.maskDims.height !== height) {
      maskCanvas.width = width
      maskCanvas.height = height
      this.maskPixels = new Uint8ClampedArray(width * height * 4)
      this.maskDims = { width, height }
    }
    const pixels = this.maskPixels
    if (!pixels) return
    for (let i = 0; i < data.length; i++) {
      pixels[i * 4 + 3] = data[i] * 255
    }
    maskCtx.putImageData(
      new ImageData(pixels as unknown as ImageDataArray, width, height),
      0,
      0,
    )
  }

  private dispose() {
    if (this.rvfcHandle !== null && this.video) {
      const video = this.video as VideoFrameCallbackVideo
      video.cancelVideoFrameCallback?.(this.rvfcHandle)
    }
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle)
    this.rvfcHandle = null
    this.rafHandle = null

    for (const track of this.output?.getTracks() ?? []) track.stop()
    this.output = null

    if (this.video) {
      this.video.pause()
      this.video.srcObject = null
      this.video = null
    }
    try {
      this.segmenter?.close()
    } catch {
      /* already closed */
    }
    this.segmenter = null
    this.canvas = null
    this.ctx = null
    this.maskCanvas = null
    this.maskCtx = null
    this.maskPixels = null
    this.maskDims = { width: 0, height: 0 }
  }
}
