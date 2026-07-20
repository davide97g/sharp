// Camera background segmentation, fully self-hosted (no CDN). The
// MediaPipe selfie segmenter + its wasm fileset live under /public/mediapipe and
// are loaded lazily — this module (and the ~11MB wasm) is only imported the first
// time a user selects blur or a wallpaper, keeping the main bundle lean like the
// tldraw editor.
//
// The processor takes the raw camera track, runs per-frame segmentation, then
// composites the person over blur or a wallpaper. canvas.captureStream() output
// is what peers receive, so backgrounds work for every participant automatically.
import type { ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision'

// Absolute asset paths (served from origin root, like the service worker). The
// wasm loader resolves sibling files relative to this base itself.
const WASM_BASE = new URL('/mediapipe/wasm', window.location.origin).toString()
const MODEL_URL = new URL('/mediapipe/selfie_segmenter.tflite', window.location.origin).toString()

// Output canvas capture frame rate — aligned with the effect-tier camera
// constraints in voice.ts (ideal 24, max 30).
const OUTPUT_FPS = 30
// Backdrop blur strength, expressed as a fraction of frame height so the look
// is identical at 360p and 720p (12px at 360p, 24px at 720p).
const BLUR_FRACTION = 1 / 30
// Feather the segmentation mask edge as it's upscaled to the frame — the model
// mask is low-res, and a hard edge reads as a jagged cutout halo.
const MASK_FEATHER_FRACTION = 1 / 320
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
  private backgroundImage: HTMLImageElement | null = null
  private background: { kind: 'blur' } | { kind: 'image'; url: string } = { kind: 'blur' }
  private rafHandle: number | null = null
  private rvfcHandle: number | null = null
  private stopped = false

  // Builds the pipeline and returns the processed (canvas) video track. Throws on
  // any init failure so the caller can fall back to the raw track.
  async start(
    rawTrack: MediaStreamTrack,
    background: { kind: 'blur' } | { kind: 'image'; url: string } = { kind: 'blur' },
  ): Promise<MediaStreamTrack> {
    const settings = rawTrack.getSettings()
    const width = settings.width ?? 640
    const height = settings.height ?? 360

    this.background = background
    const [segmenter, backgroundImage] = await Promise.all([
      createSegmenter(),
      background.kind === 'image' ? loadImage(background.url) : Promise.resolve(null),
    ])
    this.segmenter = segmenter
    this.backgroundImage = backgroundImage
    if (this.stopped) {
      this.dispose()
      throw new Error('Camera background was stopped during init.')
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
      throw new Error('Canvas 2D context is unavailable for camera backgrounds.')
    }
    ctx.imageSmoothingQuality = 'high'
    this.canvas = canvas
    this.ctx = ctx

    const maskCanvas = document.createElement('canvas')
    const maskCtx = maskCanvas.getContext('2d')
    if (!maskCtx) {
      this.dispose()
      throw new Error('Canvas 2D context is unavailable for camera backgrounds.')
    }
    this.maskCanvas = maskCanvas
    this.maskCtx = maskCtx

    this.output = canvas.captureStream(OUTPUT_FPS)
    const outputTrack = this.output.getVideoTracks()[0]
    if (!outputTrack) {
      this.dispose()
      throw new Error('Could not capture the processed video stream.')
    }
    // Canvas tracks default to no hint; tell the encoder to treat this like a
    // regular camera feed instead of guessing from the synthetic content.
    outputTrack.contentHint = 'motion'

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
    // Resizing the canvas resets all context state, so restore smoothing quality.
    if (canvas.width !== vw || canvas.height !== vh) {
      canvas.width = vw
      canvas.height = vh
      ctx.imageSmoothingQuality = 'high'
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
    // 1. Lay down the person mask (alpha = person probability), scaled to frame,
    //    lightly feathered so the low-res mask edge blends instead of stair-stepping.
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = `blur(${Math.max(1, Math.round(canvas.width * MASK_FEATHER_FRACTION))}px)`
    ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height)
    // 2. Keep the sharp video only where the mask is opaque (the person).
    ctx.globalCompositeOperation = 'source-in'
    ctx.filter = 'none'
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    // 3. Fill everything behind with the selected background.
    ctx.globalCompositeOperation = 'destination-over'
    if (this.background.kind === 'image' && this.backgroundImage) {
      drawImageCover(ctx, this.backgroundImage, canvas.width, canvas.height)
    } else {
      ctx.filter = `blur(${Math.round(canvas.height * BLUR_FRACTION)}px)`
      const dw = canvas.width * BACKDROP_SCALE
      const dh = canvas.height * BACKDROP_SCALE
      ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh)
    }
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
    this.backgroundImage = null
    this.canvas = null
    this.ctx = null
    this.maskCanvas = null
    this.maskCtx = null
    this.maskPixels = null
    this.maskDims = { width: 0, height: 0 }
  }
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.decoding = 'async'
  image.src = url
  await image.decode()
  return image
}

function drawImageCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const drawWidth = image.naturalWidth * scale
  const drawHeight = image.naturalHeight * scale
  context.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
}
