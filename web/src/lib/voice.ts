import {
  LocalAudioTrack,
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'
import type { VoiceParticipant } from './types'
import { videoBackgroundImageUrl, type VideoBackground } from './videoBackgrounds'
// RNNoise worklet script + wasm resolved to bundled asset URLs (no CDN). These
// are just URL strings; the worklet/wasm code is emitted as separate assets and
// the loader/node classes are dynamically imported only when NS is first used.
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

type VoiceClientOpts = {
  channelId: string
  myConnId: string
  serverUrl: string
  participantToken: string
  noiseSuppression?: boolean
  videoBackground?: VideoBackground
  // Preferred capture devices remembered from a previous call (may be stale).
  audioDeviceId?: string | null
  videoDeviceId?: string | null
  send: (type: string, payload: unknown) => void
  onSpeaking?: (connId: string, speaking: boolean) => void
  onLocalStream?: (stream: MediaStream | null) => void
  onRemoteStream?: (connId: string, stream: MediaStream | null) => void
  onLocalScreen?: (stream: MediaStream | null) => void
  onRemoteScreen?: (connId: string, stream: MediaStream | null) => void
  onNoiseSuppression?: (available: boolean) => void
  onConnectionState?: (state: 'connected' | 'reconnecting' | 'disconnected') => void
}

type RnnoiseModule = {
  RnnoiseWorkletNode: typeof import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode
  wasmBinary: ArrayBuffer
}

type RemoteMedia = {
  stream: MediaStream
  screenStream: MediaStream
  audioElements: Map<string, HTMLMediaElement>
}

type SpeakingDetector = {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  samples: Uint8Array<ArrayBuffer>
  speaking: boolean
  lastAboveThreshold: number
  level: number
}

const SPEAKING_THRESHOLD = 0.04
const SPEAKING_HYSTERESIS_MS = 150
const VIDEO_MAX_BITRATE = 1_200_000
// Composited backgrounds (sharp person edge over a detailed wallpaper) are much
// harder to encode than a natural webcam frame, and the effect runs at 720p —
// give those senders a bigger budget so the frame doesn't smear.
const VIDEO_EFFECT_MAX_BITRATE = 1_200_000
const SCREEN_MAX_BITRATE = 2_500_000

export class VoiceClient {
  private channelId: string
  private myConnId: string
  private serverUrl: string
  private participantToken: string
  private room: Room
  private send: (type: string, payload: unknown) => void
  private onSpeaking?: (connId: string, speaking: boolean) => void
  private onLocalStream?: (stream: MediaStream | null) => void
  private onRemoteStream?: (connId: string, stream: MediaStream | null) => void
  private onLocalScreen?: (stream: MediaStream | null) => void
  private onRemoteScreen?: (connId: string, stream: MediaStream | null) => void
  private onNoiseSuppression?: (available: boolean) => void
  private onConnectionState?: VoiceClientOpts['onConnectionState']

  private localStream: MediaStream | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private screenStream: MediaStream | null = null
  private audioDeviceId: string | null = null
  private videoDeviceId: string | null = null
  private remoteMedia = new Map<string, RemoteMedia>()
  private activeSpeakerIds = new Set<string>()
  private microphonePublicationTrack: LocalAudioTrack | null = null
  private cameraPublicationTrack: LocalVideoTrack | null = null
  private screenPublicationTracks: LocalTrack[] = []
  private audioContext: AudioContext | null = null
  private speakingDetectors = new Map<string, SpeakingDetector>()
  private speakingFrame: number | null = null
  private spectrumSamples: Uint8Array<ArrayBuffer> | null = null
  private stopped = false

  // Noise suppression (RNNoise). rawStream holds the unprocessed mic; when NS is
  // active the localStream/senders carry the processed track from the worklet
  // chain instead. nsUnavailable latches after a load/support failure so we stop
  // retrying and surface the toggle as disabled.
  private noiseSuppression: boolean
  private rawStream: MediaStream | null = null
  private micSource: MediaStreamAudioSourceNode | null = null
  private rnnoiseNode: import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode | null = null
  private micDestination: MediaStreamAudioDestinationNode | null = null
  private nsUnavailable = false
  private nsLoad: Promise<RnnoiseModule> | null = null

  // Camera background (MediaPipe selfie segmentation). rawCameraTrack is the live
  // camera from getUserMedia (owns the 'ended' listener and the real deviceId);
  // cameraTrack is what actually gets published — the raw track when blur is off,
  // the processor's canvas output when an effect is on. backgroundOp guards against
  // overlapping toggles/device-switches racing each other across awaits.
  private videoBackground: VideoBackground
  private rawCameraTrack: MediaStreamTrack | null = null
  private blurProcessor: import('./videoEffects').BackgroundBlurProcessor | null = null
  private backgroundOp = 0

  constructor(opts: VoiceClientOpts) {
    this.channelId = opts.channelId
    this.myConnId = opts.myConnId
    this.serverUrl = opts.serverUrl
    this.participantToken = opts.participantToken
    this.room = new Room({
      adaptiveStream: { pixelDensity: 1, pauseVideoInBackground: true },
      dynacast: true,
      disconnectOnPageLeave: true,
      publishDefaults: {
        simulcast: true,
        videoEncoding: VideoPresets.h720.encoding,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        screenShareEncoding: { maxBitrate: SCREEN_MAX_BITRATE, maxFramerate: 30 },
        degradationPreference: 'maintain-framerate',
        dtx: true,
        red: true,
      },
    })
    this.noiseSuppression = opts.noiseSuppression ?? true
    this.videoBackground = opts.videoBackground ?? { id: 'none' }
    this.audioDeviceId = opts.audioDeviceId ?? null
    this.videoDeviceId = opts.videoDeviceId ?? null
    this.send = opts.send
    this.onSpeaking = opts.onSpeaking
    this.onLocalStream = opts.onLocalStream
    this.onRemoteStream = opts.onRemoteStream
    this.onLocalScreen = opts.onLocalScreen
    this.onRemoteScreen = opts.onRemoteScreen
    this.onNoiseSuppression = opts.onNoiseSuppression
    this.onConnectionState = opts.onConnectionState
    this.bindRoomEvents()
  }

  async start(audioDeviceId?: string | null) {
    await this.room.connect(this.serverUrl, this.participantToken, { autoSubscribe: true })
    if (this.stopped) {
      await this.room.disconnect()
      return
    }
    const wanted = audioDeviceId ?? this.audioDeviceId
    const stream = await getUserMediaWithFallback(
      (id) => ({ audio: audioConstraints(id) }),
      wanted,
    )
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.rawStream = stream
    const rawTrack = stream.getAudioTracks()[0]
    this.audioDeviceId = trackDeviceId(rawTrack) ?? wanted ?? null
    const active = await this.buildActiveAudioTrack(rawTrack)
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      this.teardownChain()
      return
    }
    // localStream holds whatever is sent to peers (processed track when NS is
    // active); the raw mic lives in rawStream feeding the worklet chain.
    const local = new MediaStream()
    if (active) local.addTrack(active)
    this.localStream = local
    this.startSpeakingDetection(this.myConnId, local)
    if (active) {
      const publication = await this.room.localParticipant.publishTrack(active, {
        source: Track.Source.Microphone,
        name: 'microphone',
        stream: `camera:${this.myConnId}`,
        dtx: true,
        red: true,
      })
      this.microphonePublicationTrack = publication.track as LocalAudioTrack | null
    }
    this.onConnectionState?.('connected')
  }

  private bindRoomEvents() {
    this.room
      .on(RoomEvent.TrackSubscribed, this.handleTrackSubscribed)
      .on(RoomEvent.TrackUnsubscribed, this.handleTrackUnsubscribed)
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        this.removePeer(participant.identity)
      })
      .on(RoomEvent.ActiveSpeakersChanged, (participants) => {
        const next = new Set(participants.map((participant) => participant.identity))
        for (const identity of this.activeSpeakerIds) {
          if (!next.has(identity)) this.onSpeaking?.(identity, false)
        }
        for (const identity of next) {
          if (!this.activeSpeakerIds.has(identity)) this.onSpeaking?.(identity, true)
        }
        this.activeSpeakerIds = next
      })
      .on(RoomEvent.Reconnecting, () => {
        if (!this.stopped) this.onConnectionState?.('reconnecting')
      })
      .on(RoomEvent.Reconnected, () => {
        if (!this.stopped) this.onConnectionState?.('connected')
      })
      .on(RoomEvent.Disconnected, () => {
        if (!this.stopped) this.onConnectionState?.('disconnected')
      })
  }

  private handleTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    if (this.stopped) return
    const media = this.ensureRemoteMedia(participant.identity)
    const screen =
      publication.source === Track.Source.ScreenShare ||
      publication.source === Track.Source.ScreenShareAudio
    if (track.kind === Track.Kind.Audio) {
      const element = track.attach()
      element.autoplay = true
      element.style.display = 'none'
      document.body.appendChild(element)
      media.audioElements.set(publication.trackSid, element)
      return
    }
    const target = screen ? media.screenStream : media.stream
    if (!target.getTracks().some((candidate) => candidate.id === track.mediaStreamTrack.id)) {
      target.addTrack(track.mediaStreamTrack)
    }
    this.emitRemote(participant.identity, media)
  }

  private handleTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    const media = this.remoteMedia.get(participant.identity)
    if (!media) return
    const element = media.audioElements.get(publication.trackSid)
    if (element) {
      track.detach(element)
      element.remove()
      media.audioElements.delete(publication.trackSid)
    }
    media.stream.removeTrack(track.mediaStreamTrack)
    media.screenStream.removeTrack(track.mediaStreamTrack)
    this.emitRemote(participant.identity, media)
  }

  private ensureRemoteMedia(connId: string): RemoteMedia {
    const existing = this.remoteMedia.get(connId)
    if (existing) return existing
    const media: RemoteMedia = {
      stream: new MediaStream(),
      screenStream: new MediaStream(),
      audioElements: new Map(),
    }
    this.remoteMedia.set(connId, media)
    return media
  }

  getAudioDeviceId(): string | null {
    return this.audioDeviceId ?? trackDeviceId(this.localStream?.getAudioTracks()[0])
  }

  getVideoDeviceId(): string | null {
    // Always the RAW camera track — the processed canvas track has no deviceId.
    return this.videoDeviceId ?? trackDeviceId(this.rawCameraTrack)
  }

  // Fill `bands` with normalized (0..1) levels of the local mic's speech
  // spectrum (~90Hz–6kHz, log-spaced bands, low frequencies first). Reuses the
  // speaking-detection analyser, so it costs one getByteFrequencyData per call.
  // Returns false when no local mic is being analysed.
  getLocalSpectrum(bands: Float32Array): boolean {
    const detector = this.speakingDetectors.get(this.myConnId)
    if (!detector || this.stopped || bands.length === 0) return false
    const analyser = detector.analyser
    if (!this.spectrumSamples || this.spectrumSamples.length !== analyser.frequencyBinCount) {
      this.spectrumSamples = new Uint8Array(analyser.frequencyBinCount)
    }
    analyser.getByteFrequencyData(this.spectrumSamples)
    const binHz = (this.audioContext?.sampleRate ?? 48_000) / analyser.fftSize
    const maxBin = Math.max(2, Math.min(analyser.frequencyBinCount - 1, Math.round(6000 / binHz)))
    let start = 1
    for (let i = 0; i < bands.length; i++) {
      const end =
        i === bands.length - 1
          ? maxBin + 1
          : Math.min(maxBin + 1, Math.max(start + 1, Math.round(maxBin ** ((i + 1) / bands.length))))
      let sum = 0
      for (let bin = start; bin < end; bin++) sum += this.spectrumSamples[bin]
      bands[i] = end > start ? sum / ((end - start) * 255) : 0
      start = end
    }
    return true
  }

  // Smoothed 0..1 speech energy for audio-reactive UI. Reading this is cheap:
  // the detector loop already calculates RMS for local and remote microphones.
  getVoiceLevel(connIds: readonly string[]): number {
    let level = 0
    for (const connId of connIds) {
      const remote = this.room.remoteParticipants.get(connId)
      level = Math.max(
        level,
        connId === this.myConnId
          ? this.speakingDetectors.get(connId)?.level ?? this.room.localParticipant.audioLevel
          : remote?.audioLevel ?? 0,
      )
    }
    return level
  }

  async setAudioInput(deviceId: string) {
    if (this.stopped || !this.localStream) return
    if (deviceId === this.getAudioDeviceId()) return

    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(deviceId),
    })
    const nextRaw = nextStream.getAudioTracks()[0]
    if (!nextRaw) {
      for (const track of nextStream.getTracks()) track.stop()
      throw new Error('No microphone was found.')
    }
    if (this.stopped || !this.localStream) {
      for (const track of nextStream.getTracks()) track.stop()
      return
    }

    const previousActive = this.localStream.getAudioTracks()[0]
    const wasEnabled = previousActive?.enabled ?? true
    const previousRaw = this.rawStream?.getAudioTracks()[0] ?? null

    // buildActiveAudioTrack tears down the old chain (releasing the old raw
    // source) before wiring the new mic, so the old raw is safe to stop after.
    this.rawStream = nextStream
    const nextActive = await this.buildActiveAudioTrack(nextRaw)
    if (this.stopped || !this.localStream || !nextActive) {
      for (const track of nextStream.getTracks()) track.stop()
      return
    }
    nextActive.enabled = wasEnabled

    if (previousActive) {
      this.localStream.removeTrack(previousActive)
      if (previousActive !== previousRaw) previousActive.stop()
    }
    if (previousRaw) previousRaw.stop()
    this.localStream.addTrack(nextActive)
    this.audioDeviceId = trackDeviceId(nextRaw) ?? deviceId
    await this.replaceSenderTrack('audio', nextActive)
    this.stopSpeakingDetection(this.myConnId)
    this.startSpeakingDetection(this.myConnId, this.localStream)
  }

  // Runtime toggle without rejoining: rebuild the active audio track from the
  // live raw mic and swap it into the senders, preserving mute state, then
  // re-run speaking detection on what peers now hear.
  async setNoiseSuppression(enabled: boolean) {
    if (this.stopped) return
    this.noiseSuppression = enabled
    const rawTrack = this.rawStream?.getAudioTracks()[0]
    if (!this.localStream || !rawTrack) return

    const previous = this.localStream.getAudioTracks()[0]
    const wasEnabled = previous?.enabled ?? true
    const nextActive = await this.buildActiveAudioTrack(rawTrack)
    if (this.stopped || !this.localStream || !nextActive || nextActive === previous) return
    nextActive.enabled = wasEnabled

    if (previous) {
      this.localStream.removeTrack(previous)
      // The raw track is kept alive (it feeds the chain / is the fallback);
      // only a processed destination track should be stopped here.
      if (previous !== rawTrack) previous.stop()
    }
    this.localStream.addTrack(nextActive)
    await this.replaceSenderTrack('audio', nextActive)
    this.stopSpeakingDetection(this.myConnId)
    this.startSpeakingDetection(this.myConnId, this.localStream)
  }

  // Returns the track to send for the current NS setting: the RNNoise-processed
  // track when NS is on and usable, otherwise the raw (native-constraint) track.
  // Always tears down any previous chain first. Reports availability so the UI
  // can disable the toggle when NS can't run.
  private async buildActiveAudioTrack(
    rawTrack: MediaStreamTrack | undefined,
  ): Promise<MediaStreamTrack | null> {
    this.teardownChain()
    if (!rawTrack) return null
    if (!this.noiseSuppression) {
      this.onNoiseSuppression?.(!this.nsUnavailable)
      return rawTrack
    }
    const processed = await this.buildProcessedTrack(rawTrack)
    this.onNoiseSuppression?.(processed !== null)
    return processed ?? rawTrack
  }

  private async buildProcessedTrack(
    rawTrack: MediaStreamTrack,
  ): Promise<MediaStreamTrack | null> {
    try {
      const context = this.ensureAudioContext()
      const mod = await this.ensureRnnoise(context)
      if (!mod || this.stopped) return null
      const source = context.createMediaStreamSource(new MediaStream([rawTrack]))
      const node = new mod.RnnoiseWorkletNode(context, {
        maxChannels: 1,
        wasmBinary: mod.wasmBinary,
      })
      const destination = context.createMediaStreamDestination()
      source.connect(node).connect(destination)
      const track = destination.stream.getAudioTracks()[0]
      if (!track) {
        source.disconnect()
        node.destroy()
        return null
      }
      this.micSource = source
      this.rnnoiseNode = node
      this.micDestination = destination
      return track
    } catch (error) {
      this.markNsUnavailable(error)
      this.teardownChain()
      return null
    }
  }

  private ensureRnnoise(context: AudioContext): Promise<RnnoiseModule> | null {
    if (this.nsUnavailable) return null
    if (typeof AudioWorkletNode === 'undefined' || !context.audioWorklet) {
      this.markNsUnavailable()
      return null
    }
    // RNNoise assumes 48kHz; if we couldn't get a 48kHz context, don't process.
    if (context.sampleRate !== 48_000) {
      this.markNsUnavailable()
      return null
    }
    if (!this.nsLoad) {
      this.nsLoad = (async () => {
        const mod = await import('@sapphi-red/web-noise-suppressor')
        const wasmBinary = await mod.loadRnnoise({
          url: rnnoiseWasmUrl,
          simdUrl: rnnoiseSimdWasmUrl,
        })
        await context.audioWorklet.addModule(rnnoiseWorkletUrl)
        return { RnnoiseWorkletNode: mod.RnnoiseWorkletNode, wasmBinary }
      })().catch((error) => {
        this.markNsUnavailable(error)
        this.nsLoad = null
        throw error
      })
    }
    return this.nsLoad
  }

  private markNsUnavailable(error?: unknown) {
    if (!this.nsUnavailable) {
      this.nsUnavailable = true
      console.warn('Microphone noise suppression is unavailable; using the raw mic.', error)
    }
  }

  private teardownChain() {
    if (this.rnnoiseNode) {
      try {
        this.rnnoiseNode.disconnect()
        this.rnnoiseNode.destroy()
      } catch {
        // already torn down
      }
      this.rnnoiseNode = null
    }
    if (this.micSource) {
      this.micSource.disconnect()
      this.micSource = null
    }
    if (this.micDestination) {
      this.micDestination.disconnect()
      this.micDestination = null
    }
  }

  private ensureAudioContext(): AudioContext {
    if (!this.audioContext) {
      try {
        this.audioContext = new AudioContext({ sampleRate: 48_000 })
      } catch {
        this.audioContext = new AudioContext()
      }
    }
    void this.audioContext.resume().catch(() => {})
    return this.audioContext
  }

  async setVideoInput(deviceId: string) {
    if (this.stopped) return
    this.videoDeviceId = deviceId
    if (!this.cameraTrack || !this.localStream || !this.rawCameraTrack) return
    if (deviceId === trackDeviceId(this.rawCameraTrack)) return

    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(deviceId, this.videoBackground.id !== 'none'),
    })
    const nextRaw = cameraStream.getVideoTracks()[0]
    if (!nextRaw) {
      for (const track of cameraStream.getTracks()) track.stop()
      throw new Error('No camera was found.')
    }
    if (this.stopped || !this.localStream || !this.cameraTrack) {
      nextRaw.stop()
      return
    }

    const prevPublished = this.cameraTrack
    const prevRaw = this.rawCameraTrack
    const prevProcessor = this.blurProcessor
    prevRaw?.removeEventListener('ended', this.handleCameraEnded)
    this.rawCameraTrack = nextRaw
    nextRaw.addEventListener('ended', this.handleCameraEnded, { once: true })

    // Rebuild the blur pipeline (if any) around the new raw track before swapping.
    const { track: published, processor } = await this.makeCameraProcessor(nextRaw)
    if (this.stopped || !this.localStream || this.rawCameraTrack !== nextRaw) {
      processor?.stop()
      if (published !== nextRaw) published.stop()
      return
    }

    this.blurProcessor = processor
    this.cameraTrack = published
    this.videoDeviceId = trackDeviceId(nextRaw) ?? deviceId
    this.localStream.removeTrack(prevPublished)
    this.localStream.addTrack(published)
    await this.replaceSenderTrack('video', published)

    // Tear down the previous pipeline: its processor + processed output + raw mic.
    prevProcessor?.stop()
    if (prevPublished !== prevRaw) prevPublished.stop()
    prevRaw?.stop()
    this.onLocalStream?.(this.localStream)
  }

  async startCamera() {
    if (this.stopped || !this.localStream || this.cameraTrack) return
    const cameraStream = await getUserMediaWithFallback(
      (id) => ({ video: videoConstraints(id, this.videoBackground.id !== 'none') }),
      this.videoDeviceId,
    )
    const rawTrack = cameraStream.getVideoTracks()[0]
    if (!rawTrack) {
      for (const mediaTrack of cameraStream.getTracks()) mediaTrack.stop()
      throw new Error('No camera was found.')
    }
    if (this.stopped || !this.localStream) {
      rawTrack.stop()
      return
    }

    this.rawCameraTrack = rawTrack
    this.videoDeviceId = trackDeviceId(rawTrack) ?? this.videoDeviceId
    // 'ended' (hardware unplug) fires on the raw hardware track, not the canvas.
    rawTrack.addEventListener('ended', this.handleCameraEnded, { once: true })

    const { track: published, processor } = await this.makeCameraProcessor(rawTrack)
    if (this.stopped || !this.localStream || this.rawCameraTrack !== rawTrack) {
      // Aborted mid-flight (stop/stopCamera ran): clean up anything we just built.
      processor?.stop()
      if (published !== rawTrack) published.stop()
      return
    }

    this.blurProcessor = processor
    this.cameraTrack = published
    this.localStream.addTrack(published)
    const publication = await this.room.localParticipant.publishTrack(published, {
      source: Track.Source.Camera,
      name: 'camera',
      stream: `camera:${this.myConnId}`,
      simulcast: true,
      videoEncoding: { maxBitrate: this.cameraBitrate(), maxFramerate: 24 },
      videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
      degradationPreference: 'maintain-framerate',
    })
    this.cameraPublicationTrack = publication.track as LocalVideoTrack | null
    this.onLocalStream?.(this.localStream)
  }

  // Live background change without dropping the call: rebuild the published track around
  // the same raw camera and swap it into localStream + every sender. Persisting the
  // flag alone (no camera live) applies it on the next startCamera.
  async setVideoBackground(background: VideoBackground) {
    if (
      this.videoBackground.id === background.id &&
      this.videoBackground.customUrl === background.customUrl
    ) {
      return
    }
    this.videoBackground = background
    const op = ++this.backgroundOp
    if (this.stopped || !this.localStream || !this.cameraTrack || !this.rawCameraTrack) return

    const rawTrack = this.rawCameraTrack
    const prevPublished = this.cameraTrack
    const prevProcessor = this.blurProcessor
    // Retune the live camera to the quality tier of the new mode (720p with an
    // effect, 360p without) before rebuilding the pipeline around it. Best-effort:
    // a camera that can't do 720p keeps whatever it delivers.
    try {
      await rawTrack.applyConstraints(cameraQuality(background.id !== 'none'))
    } catch (error) {
      console.warn('Could not retune camera resolution for background change', error)
    }
    const { track: published, processor } = await this.makeCameraProcessor(rawTrack)
    // Bail if anything changed under us: call ended, camera stopped/switched, or a
    // newer toggle superseded this one.
    if (
      this.stopped ||
      this.backgroundOp !== op ||
      this.rawCameraTrack !== rawTrack ||
      !this.localStream ||
      !this.cameraTrack
    ) {
      processor?.stop()
      if (published !== rawTrack) published.stop()
      return
    }
    if (published === prevPublished) return

    this.blurProcessor = processor
    this.cameraTrack = published
    this.localStream.removeTrack(prevPublished)
    this.localStream.addTrack(published)
    await this.replaceSenderTrack('video', published)
    // Retire the old pipeline. Never stop rawTrack — it's the live camera, still
    // consumed by the new processor (blur on) or now published directly (blur off).
    prevProcessor?.stop()
    if (prevPublished !== rawTrack) prevPublished.stop()
    this.onLocalStream?.(this.localStream)
  }

  private cameraBitrate(): number {
    return this.videoBackground.id === 'none' ? VIDEO_MAX_BITRATE : VIDEO_EFFECT_MAX_BITRATE
  }

  // Derives the track to publish from a raw camera track. Effect off uses raw track.
  // Blur/wallpaper uses the segmentation processor's canvas output; on any init
  // failure it warns and falls back to the raw track so the call never breaks.
  private async makeCameraProcessor(
    rawTrack: MediaStreamTrack,
  ): Promise<{ track: MediaStreamTrack; processor: import('./videoEffects').BackgroundBlurProcessor | null }> {
    if (this.videoBackground.id === 'none') return { track: rawTrack, processor: null }
    try {
      const { BackgroundBlurProcessor } = await import('./videoEffects')
      const processor = new BackgroundBlurProcessor()
      const imageUrl = videoBackgroundImageUrl(this.videoBackground)
      const track = await processor.start(
        rawTrack,
        imageUrl ? { kind: 'image', url: imageUrl } : { kind: 'blur' },
      )
      return { track, processor }
    } catch (error) {
      console.warn('Could not start camera background; publishing the raw camera', error)
      return { track: rawTrack, processor: null }
    }
  }

  stopCamera() {
    const published = this.cameraTrack
    const raw = this.rawCameraTrack
    const processor = this.blurProcessor
    if (!published && !raw && !processor) return
    this.cameraTrack = null
    this.rawCameraTrack = null
    this.blurProcessor = null
    // Invalidate any in-flight startCamera/toggle so it aborts on wake.
    this.backgroundOp++
    raw?.removeEventListener('ended', this.handleCameraEnded)
    if (published) {
      this.localStream?.removeTrack(published)
      const publicationTrack = this.cameraPublicationTrack
      this.cameraPublicationTrack = null
      if (publicationTrack) {
        void this.room.localParticipant.unpublishTrack(publicationTrack, false).catch((error) => {
          if (!this.stopped) console.warn('Could not unpublish camera track', error)
        })
      }
    }
    // processor.stop() also stops its canvas output track; guard the double-stop.
    processor?.stop()
    if (published && published !== raw) published.stop()
    raw?.stop()
    this.onLocalStream?.(null)
  }

  private async replaceSenderTrack(kind: 'audio' | 'video', track: MediaStreamTrack) {
    const published = kind === 'audio' ? this.microphonePublicationTrack : this.cameraPublicationTrack
    if (published) await published.replaceTrack(track, { userProvidedTrack: true })
  }

  syncPeers(participants: VoiceParticipant[]) {
    if (this.stopped) return
    const present = new Set(
      participants
        .filter((participant) => participant.conn_id !== this.myConnId)
        .map((participant) => participant.conn_id),
    )
    for (const connId of this.remoteMedia.keys()) {
      if (!present.has(connId)) this.removePeer(connId)
    }
  }

  // LiveKit owns peer creation. Kept as a compatibility no-op for store events
  // that also update Sharp's participant registry.
  ensurePeer(_remoteConn: string, _remoteUser: string) {}

  removePeer(connId: string) {
    const media = this.remoteMedia.get(connId)
    if (!media) return
    this.remoteMedia.delete(connId)
    for (const element of media.audioElements.values()) element.remove()
    for (const track of media.stream.getTracks()) media.stream.removeTrack(track)
    for (const track of media.screenStream.getTracks()) media.screenStream.removeTrack(track)
    this.onRemoteStream?.(connId, null)
    this.onRemoteScreen?.(connId, null)
    if (this.activeSpeakerIds.delete(connId)) this.onSpeaking?.(connId, false)
  }

  private emitRemote(connId: string, media: RemoteMedia) {
    this.onRemoteStream?.(connId, media.stream.getVideoTracks().length ? media.stream : null)
    this.onRemoteScreen?.(
      connId,
      media.screenStream.getVideoTracks().length ? media.screenStream : null,
    )
  }

  // Track source metadata comes from LiveKit; Sharp screen metadata remains
  // authoritative only for UI reservation and annotation permissions.
  updateRemoteScreen(_connId: string, _streamId: string | null) {}

  async acquireScreen(): Promise<string> {
    if (this.stopped) throw new Error('Call ended.')
    // getDisplayMedia needs transient user activation, so this runs synchronously
    // in the click gesture — before the server round-trip, unlike the camera.
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      audio: true,
    })
    const videoTrack = stream.getVideoTracks()[0]
    if (!videoTrack) {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('No screen was shared.')
    }
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('Call ended.')
    }
    videoTrack.contentHint = 'detail'
    this.screenStream = stream
    videoTrack.addEventListener('ended', this.handleScreenEnded, { once: true })
    return stream.id
  }

  publishScreen() {
    const stream = this.screenStream
    if (this.stopped || !stream) return
    const publish = async () => {
      const publications = await Promise.all(
        stream.getTracks().map((track) =>
          this.room.localParticipant.publishTrack(track, {
            source:
              track.kind === 'video' ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio,
            name: track.kind === 'video' ? 'screen' : 'screen-audio',
            stream: `screen:${this.myConnId}`,
            simulcast: track.kind === 'video',
            screenShareEncoding:
              track.kind === 'video'
                ? { maxBitrate: SCREEN_MAX_BITRATE, maxFramerate: 30 }
                : undefined,
            degradationPreference: track.kind === 'video' ? 'maintain-resolution' : undefined,
          }),
        ),
      )
      if (this.stopped || this.screenStream !== stream) {
        await Promise.all(
          publications.flatMap((publication) =>
            publication.track
              ? [this.room.localParticipant.unpublishTrack(publication.track, false)]
              : [],
          ),
        )
        return
      }
      this.screenPublicationTracks = publications.flatMap((publication) =>
        publication.track ? [publication.track] : [],
      )
      this.onLocalScreen?.(stream)
    }
    void publish().catch((error) => {
      if (this.stopped) return
      console.warn('Could not publish screen share', error)
      this.stopScreenShare()
      this.send('voice.screen', { channel_id: this.channelId, enabled: false })
    })
  }

  stopScreenShare() {
    const stream = this.screenStream
    if (!stream) return
    this.screenStream = null
    for (const track of stream.getTracks()) {
      track.removeEventListener('ended', this.handleScreenEnded)
    }
    const publicationTracks = this.screenPublicationTracks
    this.screenPublicationTracks = []
    for (const track of publicationTracks) {
      void this.room.localParticipant.unpublishTrack(track, false).catch((error) => {
        if (!this.stopped) console.warn('Could not unpublish screen track', error)
      })
    }
    for (const track of stream.getTracks()) track.stop()
    this.onLocalScreen?.(null)
  }

  setMuted(muted: boolean) {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }
    const publication = this.microphonePublicationTrack
    if (publication) void (muted ? publication.mute() : publication.unmute())
  }

  stop() {
    if (this.stopped) return
    this.stopped = true

    this.stopCamera()
    this.stopScreenShare()
    for (const connId of [...this.remoteMedia.keys()]) this.removePeer(connId)
    this.teardownChain()
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    for (const track of this.rawStream?.getTracks() ?? []) track.stop()
    this.localStream = null
    this.rawStream = null

    if (this.speakingFrame !== null) {
      cancelAnimationFrame(this.speakingFrame)
      this.speakingFrame = null
    }
    for (const connId of [...this.speakingDetectors.keys()]) {
      this.stopSpeakingDetection(connId)
    }
    if (this.audioContext) {
      void this.audioContext.close().catch(() => {})
      this.audioContext = null
    }
    void this.room.disconnect()
  }

  private handleCameraEnded = () => {
    if (this.stopped || !this.rawCameraTrack) return
    this.stopCamera()
    this.send('voice.camera', { channel_id: this.channelId, enabled: false })
  }

  // Browser's native "Stop sharing" bar fires 'ended' on the screen video track.
  private handleScreenEnded = () => {
    if (this.stopped || !this.screenStream) return
    this.stopScreenShare()
    this.send('voice.screen', { channel_id: this.channelId, enabled: false })
  }

  private startSpeakingDetection(connId: string, stream: MediaStream) {
    if (this.stopped || this.speakingDetectors.has(connId) || !stream.getAudioTracks().length) {
      return
    }
    const context = this.ensureAudioContext()

    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    this.speakingDetectors.set(connId, {
      source,
      analyser,
      samples: new Uint8Array(analyser.fftSize),
      speaking: false,
      lastAboveThreshold: 0,
      level: 0,
    })

    if (this.speakingFrame === null) this.speakingFrame = requestAnimationFrame(this.detectSpeaking)
  }

  private stopSpeakingDetection(connId: string) {
    const detector = this.speakingDetectors.get(connId)
    if (!detector) return
    this.speakingDetectors.delete(connId)
    detector.source.disconnect()
    detector.analyser.disconnect()
    if (detector.speaking) this.onSpeaking?.(connId, false)
  }

  private detectSpeaking = (now: number) => {
    if (this.stopped) {
      this.speakingFrame = null
      return
    }

    for (const [connId, detector] of this.speakingDetectors) {
      detector.analyser.getByteTimeDomainData(detector.samples)
      let sumSquares = 0
      for (const sample of detector.samples) {
        const centered = (sample - 128) / 128
        sumSquares += centered * centered
      }
      const rms = Math.sqrt(sumSquares / detector.samples.length)
      const normalized = Math.min(1, Math.max(0, (rms - 0.018) / 0.16)) ** 0.72
      const smoothing = normalized > detector.level ? 0.42 : 0.13
      detector.level += (normalized - detector.level) * smoothing
      if (rms >= SPEAKING_THRESHOLD) detector.lastAboveThreshold = now
      const speaking =
        rms >= SPEAKING_THRESHOLD ||
        (detector.speaking && now - detector.lastAboveThreshold < SPEAKING_HYSTERESIS_MS)
      if (speaking !== detector.speaking) {
        detector.speaking = speaking
        this.onSpeaking?.(connId, speaking)
      }
    }

    this.speakingFrame = requestAnimationFrame(this.detectSpeaking)
  }
}

// Acquire media for a preferred deviceId, but survive a stale one. A remembered
// device that's since been unplugged makes the `{ exact }` constraint throw
// OverconstrainedError; retry once without the pin so the call still connects on
// whatever device is available rather than failing the whole join.
async function getUserMediaWithFallback(
  build: (deviceId: string | null) => MediaStreamConstraints,
  deviceId: string | null,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(build(deviceId))
  } catch (error) {
    // OverconstrainedError isn't reliably a DOMException across browsers, and a
    // vanished device can surface as NotFoundError — match on name, not type.
    const name = (error as { name?: string } | null)?.name
    if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
      return await navigator.mediaDevices.getUserMedia(build(null))
    }
    throw error
  }
}

function trackDeviceId(track?: MediaStreamTrack | null): string | null {
  const id = track?.getSettings().deviceId
  return id || null
}

function audioConstraints(deviceId?: string | null): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }
  if (deviceId) return { ...base, deviceId: { exact: deviceId } }
  return base
}

// SFU simulcast derives smaller layers for tiles while preserving a 720p source
// for active-speaker and full-stage views.
function cameraQuality(_highRes: boolean): MediaTrackConstraints {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
}

function videoConstraints(deviceId?: string | null, highRes = false): MediaTrackConstraints {
  const base = cameraQuality(highRes)
  if (deviceId) return { ...base, deviceId: { exact: deviceId } }
  return { ...base, facingMode: 'user' }
}
