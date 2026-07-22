// Single continuous mic recording for composer voice messages. Distinct from
// speech.ts (VAD-chunked live transcription): here one MediaRecorder runs from
// tap-to-record to stop, yielding one Blob. Also exposes a live spectrum
// (fftSize 512, log-spaced bands) so the composer can draw the same five-bar
// visual as MicActivityIcon, driven by our own AnalyserNode.

export const MAX_RECORDING_MS = 10 * 60 * 1000

function recordingMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus'
  }
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return null
}

export function isRecordingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    recordingMimeType() !== null
  )
}

export function recordingFileName(mimeType: string): string {
  return mimeType.includes('mp4') ? 'voice-message.m4a' : 'voice-message.webm'
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

export class VoiceRecorder {
  readonly mimeType: string
  private stream: MediaStream | null = null
  private audioContext: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private freqSamples: Uint8Array<ArrayBuffer> | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private stopped = false

  constructor() {
    const mimeType = recordingMimeType()
    if (!mimeType) throw new Error('Audio recording is not supported by this browser.')
    this.mimeType = mimeType
  }

  async start(deviceId?: string | null): Promise<void> {
    if (this.recorder || this.stopped) return
    const stream = await captureAudio(deviceId)
    if (this.stopped) {
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
    this.freqSamples = new Uint8Array(analyser.frequencyBinCount)

    const recorder = new MediaRecorder(stream, { mimeType: this.mimeType })
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    }
    this.recorder = recorder
    recorder.start()
    this.startedAt = performance.now()
  }

  // Fill `bands` with normalized (0..1) log-spaced spectrum levels (~90Hz–6kHz,
  // low frequencies first) — mirrors VoiceClient.getLocalSpectrum.
  getSpectrum(bands: Float32Array): boolean {
    const analyser = this.analyser
    const samples = this.freqSamples
    if (!analyser || !samples || bands.length === 0) return false
    analyser.getByteFrequencyData(samples)
    const binHz = (this.audioContext?.sampleRate ?? 48_000) / analyser.fftSize
    const maxBin = Math.max(2, Math.min(analyser.frequencyBinCount - 1, Math.round(6000 / binHz)))
    let start = 1
    for (let i = 0; i < bands.length; i++) {
      const end =
        i === bands.length - 1
          ? maxBin + 1
          : Math.min(maxBin + 1, Math.max(start + 1, Math.round(maxBin ** ((i + 1) / bands.length))))
      let sum = 0
      for (let bin = start; bin < end; bin++) sum += samples[bin]
      bands[i] = end > start ? sum / ((end - start) * 255) : 0
      start = end
    }
    return true
  }

  elapsedMs(): number {
    return this.startedAt ? performance.now() - this.startedAt : 0
  }

  // Stop recording and resolve with the assembled Blob (null if nothing captured).
  stop(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const recorder = this.recorder
      if (!recorder || recorder.state === 'inactive') {
        this.cleanup()
        resolve(null)
        return
      }
      recorder.addEventListener(
        'stop',
        () => {
          const blob = this.chunks.length
            ? new Blob(this.chunks, { type: recorder.mimeType || this.mimeType })
            : null
          this.cleanup()
          resolve(blob)
        },
        { once: true },
      )
      try {
        recorder.stop()
      } catch {
        this.cleanup()
        resolve(null)
      }
    })
  }

  // Discard immediately, releasing the mic without producing a Blob.
  cancel(): void {
    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch {
        /* ignore */
      }
    }
    this.cleanup()
  }

  private cleanup(): void {
    this.stopped = true
    this.recorder = null
    this.chunks = []
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.source = null
    this.analyser = null
    this.freqSamples = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    if (this.audioContext) void this.audioContext.close().catch(() => {})
    this.audioContext = null
  }
}
