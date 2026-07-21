import { api, ApiRequestError } from './api'

export type SpeechRecognitionError = 'not-allowed' | 'service-not-allowed'

const SPEECH_THRESHOLD = 0.04
const SILENCE_MS = 700
const MIN_SEGMENT_MS = 300
const MAX_SEGMENT_MS = 15_000
const MAX_PENDING_SEGMENTS = 3

type PendingSegment = {
  audio: Blob
  session: number
}

function recordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus'
  }
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return null
}

export function isTranscriptionSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    recordingMimeType() !== null
  )
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )
}

function cleanTranscript(input: string): string | null {
  const text = input.trim().slice(0, 500).trim()
  if (!text || /^[\s.,!?…—-]+$/.test(text)) return null
  const normalized = text
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (/^(?:\[|\(|<)?(?:blank audio|silence|music|no speech)(?:\]|\)|>)?[.!]?$/.test(normalized)) {
    return null
  }
  return text
}

async function captureAudio(deviceId?: string | null): Promise<MediaStream> {
  const constraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints })
  } catch (error) {
    if (
      deviceId &&
      error instanceof DOMException &&
      (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')
    ) {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
    }
    throw error
  }
}

export class PhraseRecognizer {
  private readonly onPhrase: (text: string) => void
  private readonly onError?: (error: SpeechRecognitionError) => void
  private readonly deviceId?: string | null
  private readonly mimeType: string
  private started = false
  private paused = false
  private initializing = false
  private session = 0
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private samples: Uint8Array<ArrayBuffer> | null = null
  private vadTimer: ReturnType<typeof setInterval> | null = null
  private recorder: MediaRecorder | null = null
  private recorderStopping = false
  private segmentFinish: ((upload: boolean) => void) | null = null
  private segmentStartedAt = 0
  private lastSpeechAt = 0
  private speechActive = false
  private queue: PendingSegment[] = []
  private uploading = false
  private uploadAbort: AbortController | null = null
  private consecutiveFailures = 0

  constructor({
    onPhrase,
    onError,
    deviceId,
  }: {
    lang?: string
    onPhrase: (text: string) => void
    onError?: (error: SpeechRecognitionError) => void
    deviceId?: string | null
  }) {
    const mimeType = recordingMimeType()
    if (!mimeType || !isTranscriptionSupported()) {
      throw new Error('Live transcription is not supported by this browser.')
    }
    this.mimeType = mimeType
    this.onPhrase = onPhrase
    this.onError = onError
    this.deviceId = deviceId
  }

  start() {
    if (this.started && !this.paused) return
    if (this.started) {
      this.resume()
      return
    }
    this.started = true
    this.paused = false
    const session = ++this.session
    void this.initialize(session)
  }

  stop() {
    this.started = false
    this.paused = false
    this.session += 1
    this.queue = []
    this.uploadAbort?.abort()
    this.uploadAbort = null
    this.stopVad()
    this.finishSegment(false)
    this.releaseCapture()
  }

  pause() {
    if (!this.started || this.paused) return
    this.paused = true
    this.stopVad()
    this.finishSegment(false)
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = false
    void this.audioContext?.suspend().catch(() => {})
  }

  resume() {
    if (!this.started || !this.paused) return
    this.paused = false
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = true
    if (!this.stream) {
      void this.initialize(this.session)
      return
    }
    void this.audioContext?.resume().catch(() => {})
    this.startVad()
  }

  private async initialize(session: number) {
    if (this.initializing || !this.started || this.stream) return
    this.initializing = true
    try {
      const stream = await captureAudio(this.deviceId)
      if (!this.started || session !== this.session) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      const audioContext = new AudioContext()
      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.stream = stream
      this.audioContext = audioContext
      this.source = source
      this.analyser = analyser
      this.samples = new Uint8Array(analyser.fftSize)
      if (this.paused) {
        for (const track of stream.getAudioTracks()) track.enabled = false
        await audioContext.suspend()
      } else {
        this.startVad()
      }
    } catch (error) {
      if (this.started && session === this.session) {
        this.fail(isPermissionError(error) ? 'not-allowed' : 'service-not-allowed')
      }
    } finally {
      this.initializing = false
    }
  }

  private startVad() {
    if (!this.started || this.paused || !this.analyser || this.vadTimer !== null) return
    // setInterval, not requestAnimationFrame: rAF freezes in hidden tabs, and
    // transcription must keep running while the call floats (PiP) or the user
    // browses another tab.
    this.vadTimer = setInterval(() => this.detectSpeech(performance.now()), 50)
  }

  private stopVad() {
    if (this.vadTimer !== null) clearInterval(this.vadTimer)
    this.vadTimer = null
    this.speechActive = false
    this.lastSpeechAt = 0
  }

  private detectSpeech = (now: number) => {
    const analyser = this.analyser
    const samples = this.samples
    if (!this.started || this.paused || !analyser || !samples) return

    analyser.getByteTimeDomainData(samples)
    let sumSquares = 0
    for (const sample of samples) {
      const centered = (sample - 128) / 128
      sumSquares += centered * centered
    }
    const rms = Math.sqrt(sumSquares / samples.length)
    this.speechActive = rms >= SPEECH_THRESHOLD
    if (this.speechActive) {
      this.lastSpeechAt = now
      if (!this.recorder && !this.recorderStopping) this.startSegment(now)
    }

    if (this.recorder) {
      const duration = now - this.segmentStartedAt
      if (duration >= MAX_SEGMENT_MS) {
        this.finishSegment(true, now)
      } else if (this.lastSpeechAt > 0 && now - this.lastSpeechAt >= SILENCE_MS) {
        const speechDuration = this.lastSpeechAt - this.segmentStartedAt
        this.finishSegment(speechDuration >= MIN_SEGMENT_MS, now)
      }
    }
  }

  private startSegment(now: number) {
    const stream = this.stream
    if (!stream || !this.started || this.paused) return
    const session = this.session
    const chunks: Blob[] = []
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType: this.mimeType })
    } catch {
      this.fail('service-not-allowed')
      return
    }
    this.recorder = recorder
    this.segmentStartedAt = now
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    }
    recorder.onerror = () => {
      if (this.recorder === recorder) this.fail('service-not-allowed')
    }
    recorder.onstop = () => {
      this.recorderStopping = false
      const shouldContinue =
        this.started && !this.paused && session === this.session && this.speechActive
      if (shouldContinue && !this.recorder) this.startSegment(performance.now())
    }
    this.segmentFinish = (upload) => {
      if (upload && session === this.session && chunks.length > 0) {
        const type = recorder.mimeType || this.mimeType
        this.enqueue(new Blob(chunks, { type }), session)
      }
    }
    try {
      recorder.start()
    } catch {
      this.recorder = null
      this.segmentFinish = null
      this.fail('service-not-allowed')
    }
  }

  private finishSegment(upload: boolean, now = performance.now()) {
    const recorder = this.recorder
    if (!recorder) return
    this.recorder = null
    this.recorderStopping = true
    const duration = now - this.segmentStartedAt
    const finish = this.segmentFinish
    this.segmentFinish = null
    recorder.addEventListener(
      'stop',
      () => finish?.(upload && duration >= MIN_SEGMENT_MS),
      { once: true },
    )
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        this.recorderStopping = false
        finish?.(false)
      }
    } else {
      this.recorderStopping = false
      finish?.(false)
    }
  }

  private enqueue(audio: Blob, session: number) {
    const pendingCount = this.queue.length + (this.uploading ? 1 : 0)
    if (!audio.size || pendingCount >= MAX_PENDING_SEGMENTS) return
    this.queue.push({ audio, session })
    void this.processQueue()
  }

  private async processQueue() {
    if (this.uploading) return
    const segment = this.queue.shift()
    if (!segment || segment.session !== this.session || !this.started) return
    this.uploading = true
    const controller = new AbortController()
    this.uploadAbort = controller
    try {
      const response = await api.voice.transcribe(segment.audio, controller.signal)
      if (segment.session !== this.session || !this.started) return
      this.consecutiveFailures = 0
      const text = cleanTranscript(response.text)
      if (text) this.onPhrase(text)
    } catch (error) {
      if (controller.signal.aborted || segment.session !== this.session || !this.started) return
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 501)) {
        this.fail('service-not-allowed')
        return
      }
      this.consecutiveFailures += 1
      if (this.consecutiveFailures >= 3) this.fail('service-not-allowed')
    } finally {
      if (this.uploadAbort === controller) this.uploadAbort = null
      this.uploading = false
      if (this.started && segment.session === this.session) void this.processQueue()
    }
  }

  private fail(error: SpeechRecognitionError) {
    if (!this.started) return
    this.stop()
    this.onError?.(error)
  }

  private releaseCapture() {
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.source = null
    this.analyser = null
    this.samples = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    if (this.audioContext) void this.audioContext.close().catch(() => {})
    this.audioContext = null
  }
}
