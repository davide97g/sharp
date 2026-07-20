import type { VoiceParticipant, VoiceSignalPayload } from './types'
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
  myUserId: string
  iceServers: RTCIceServer[]
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
}

type RnnoiseModule = {
  RnnoiseWorkletNode: typeof import('@sapphi-red/web-noise-suppressor').RnnoiseWorkletNode
  wasmBinary: ArrayBuffer
}

type Peer = {
  pc: RTCPeerConnection
  remoteUser: string
  audio: HTMLAudioElement
  stream: MediaStream
  // Receiver-side container for the remote screen share (separate MediaStream so a
  // second video track never collides with the camera track).
  screenStream: MediaStream
  // Plays the remote system/tab audio; NEVER fed to speaking detection.
  screenAudio: HTMLAudioElement
  // The msid the sharer advertised out-of-band via voice.screen; tracks whose
  // origin stream id matches this are screen tracks.
  screenStreamId: string | null
  // track.id -> incoming event.streams[0].id, so updateRemoteScreen can reclassify
  // a track that arrived before its metadata.
  trackOrigins: Map<string, string>
  pendingCandidates: RTCIceCandidateInit[]
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  isSettingRemoteAnswerPending: boolean
  negotiated: boolean
}

type SpeakingDetector = {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  samples: Uint8Array<ArrayBuffer>
  speaking: boolean
  lastAboveThreshold: number
}

const SPEAKING_THRESHOLD = 0.04
const SPEAKING_HYSTERESIS_MS = 150
const VIDEO_MAX_BITRATE = 500_000
// Composited backgrounds (sharp person edge over a detailed wallpaper) are much
// harder to encode than a natural webcam frame, and the effect runs at 720p —
// give those senders a bigger budget so the frame doesn't smear.
const VIDEO_EFFECT_MAX_BITRATE = 1_200_000
const SCREEN_MAX_BITRATE = 2_500_000

export class VoiceClient {
  private channelId: string
  private myConnId: string
  private myUserId: string
  private iceServers: RTCIceServer[]
  private send: (type: string, payload: unknown) => void
  private onSpeaking?: (connId: string, speaking: boolean) => void
  private onLocalStream?: (stream: MediaStream | null) => void
  private onRemoteStream?: (connId: string, stream: MediaStream | null) => void
  private onLocalScreen?: (stream: MediaStream | null) => void
  private onRemoteScreen?: (connId: string, stream: MediaStream | null) => void
  private onNoiseSuppression?: (available: boolean) => void

  private localStream: MediaStream | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private screenStream: MediaStream | null = null
  private pendingScreen = false
  private audioDeviceId: string | null = null
  private videoDeviceId: string | null = null
  private peers = new Map<string, Peer>()
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
    this.myUserId = opts.myUserId
    this.iceServers = opts.iceServers
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
  }

  async start(audioDeviceId?: string | null) {
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
    for (const peer of this.peers.values()) {
      const sender = peer.pc.addTrack(published, this.localStream)
      void configureVideoSender(sender, this.cameraBitrate())
    }
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
      for (const peer of this.peers.values()) {
        const sender = peer.pc.getSenders().find((candidate) => candidate.track === published)
        if (sender) peer.pc.removeTrack(sender)
      }
    }
    // processor.stop() also stops its canvas output track; guard the double-stop.
    processor?.stop()
    if (published && published !== raw) published.stop()
    raw?.stop()
    this.onLocalStream?.(null)
  }

  private async replaceSenderTrack(kind: 'audio' | 'video', track: MediaStreamTrack) {
    // Exclude senders whose track belongs to the screen share so switching a
    // camera/mic device doesn't hijack the screen sender (screen carries its own
    // video and, when the OS allows, audio track).
    const screenTrackIds = new Set(this.screenStream?.getTracks().map((t) => t.id) ?? [])
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.pc
          .getSenders()
          .find(
            (candidate) =>
              candidate.track?.kind === kind &&
              !(candidate.track && screenTrackIds.has(candidate.track.id)),
          )
        if (sender) {
          await sender.replaceTrack(track)
          if (kind === 'video') void configureVideoSender(sender, this.cameraBitrate())
          return
        }
        if (this.localStream) {
          const added = peer.pc.addTrack(track, this.localStream)
          if (kind === 'video') void configureVideoSender(added, this.cameraBitrate())
        }
      }),
    )
  }

  syncPeers(participants: VoiceParticipant[]) {
    if (this.stopped) return
    const present = new Set<string>()
    for (const participant of participants) {
      if (
        participant.conn_id === this.myConnId ||
        participant.user_id === this.myUserId
      ) {
        continue
      }
      present.add(participant.conn_id)
      this.ensurePeer(participant.conn_id, participant.user_id)
    }
    for (const connId of this.peers.keys()) {
      if (!present.has(connId)) this.removePeer(connId)
    }
  }

  ensurePeer(remoteConn: string, remoteUser: string) {
    if (
      this.stopped ||
      !this.localStream ||
      remoteConn === this.myConnId ||
      remoteUser === this.myUserId ||
      this.peers.has(remoteConn)
    ) {
      return
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const stream = new MediaStream()
    const screenStream = new MediaStream()
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.style.display = 'none'
    audio.srcObject = stream
    document.body.appendChild(audio)
    const screenAudio = document.createElement('audio')
    screenAudio.autoplay = true
    screenAudio.style.display = 'none'
    screenAudio.srcObject = screenStream
    document.body.appendChild(screenAudio)
    const peer: Peer = {
      pc,
      remoteUser,
      audio,
      stream,
      screenStream,
      screenAudio,
      screenStreamId: null,
      trackOrigins: new Map(),
      pendingCandidates: [],
      polite: this.myConnId > remoteConn,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      negotiated: false,
    }
    this.peers.set(remoteConn, peer)

    for (const track of this.localStream.getTracks()) {
      const sender = pc.addTrack(track, this.localStream)
      if (track.kind === 'video') void configureVideoSender(sender, this.cameraBitrate())
    }

    // Late joiner: publish our ongoing screen share to the new peer.
    if (this.screenStream && !this.pendingScreen) {
      for (const track of this.screenStream.getTracks()) {
        const sender = pc.addTrack(track, this.screenStream)
        if (track.kind === 'video') void configureScreenSender(sender)
      }
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.stopped || this.peers.get(remoteConn) !== peer) return
      this.sendSignal(remoteUser, remoteConn, 'candidate', event.candidate.toJSON())
    }

    pc.ontrack = (event) => {
      if (this.stopped || this.peers.get(remoteConn) !== peer) return
      const originId = event.streams[0]?.id ?? null
      if (originId) peer.trackOrigins.set(event.track.id, originId)
      const isScreen = originId !== null && originId === peer.screenStreamId
      const target = isScreen ? peer.screenStream : peer.stream
      if (!target.getTracks().some((track) => track.id === event.track.id)) {
        target.addTrack(event.track)
      }
      // Screen audio plays via the hidden screenAudio element (srcObject is the
      // screenStream); only mic audio drives speaking detection.
      if (event.track.kind === 'audio' && !isScreen) {
        this.startSpeakingDetection(remoteConn, peer.stream)
      }
      event.track.addEventListener(
        'ended',
        () => {
          if (this.peers.get(remoteConn) !== peer) return
          peer.trackOrigins.delete(event.track.id)
          peer.stream.removeTrack(event.track)
          peer.screenStream.removeTrack(event.track)
          this.emitRemote(remoteConn, peer)
        },
        { once: true },
      )
      this.emitRemote(remoteConn, peer)
    }

    pc.onnegotiationneeded = async () => {
      // Let one deterministic peer make the first offer. Perfect negotiation
      // handles later simultaneous camera changes after the connection exists.
      if (!peer.negotiated && this.myConnId > remoteConn) return
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        const description = pc.localDescription
        if (
          this.stopped ||
          this.peers.get(remoteConn) !== peer ||
          !description ||
          (description.type !== 'offer' && description.type !== 'answer')
        ) {
          return
        }
        this.sendSignal(remoteUser, remoteConn, description.type, {
          type: description.type,
          sdp: description.sdp,
        })
      } catch (error) {
        if (!this.stopped) console.error('Failed to negotiate voice peer', error)
      } finally {
        peer.makingOffer = false
      }
    }
  }

  async onSignal(payload: VoiceSignalPayload) {
    if (
      this.stopped ||
      payload.to_conn !== this.myConnId ||
      payload.channel_id !== this.channelId
    ) {
      return
    }

    this.ensurePeer(payload.from_conn, payload.from_user)
    const peer = this.peers.get(payload.from_conn)
    if (!peer) return

    if (payload.kind === 'candidate') {
      const candidate = payload.data as RTCIceCandidateInit
      if (!peer.pc.remoteDescription) {
        peer.pendingCandidates.push(candidate)
        return
      }
      try {
        await peer.pc.addIceCandidate(candidate)
      } catch (error) {
        if (!peer.ignoreOffer) throw error
      }
      return
    }

    const description = payload.data as RTCSessionDescriptionInit
    const readyForOffer =
      !peer.makingOffer &&
      (peer.pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending)
    const offerCollision = description.type === 'offer' && !readyForOffer
    peer.ignoreOffer = !peer.polite && offerCollision
    if (peer.ignoreOffer) return

    peer.isSettingRemoteAnswerPending = description.type === 'answer'
    await peer.pc.setRemoteDescription(description)
    peer.isSettingRemoteAnswerPending = false
    peer.negotiated = true
    await this.flushCandidates(peer)

    if (description.type === 'offer') {
      await peer.pc.setLocalDescription()
      if (this.stopped || this.peers.get(payload.from_conn) !== peer || !peer.pc.localDescription) {
        return
      }
      this.sendSignal(payload.from_user, payload.from_conn, 'answer', {
        type: peer.pc.localDescription.type,
        sdp: peer.pc.localDescription.sdp,
      })
    }
  }

  removePeer(connId: string) {
    const peer = this.peers.get(connId)
    if (!peer) return
    this.peers.delete(connId)
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.onnegotiationneeded = null
    peer.pc.close()
    peer.audio.remove()
    peer.screenAudio.remove()
    for (const track of peer.stream.getTracks()) track.stop()
    for (const track of peer.screenStream.getTracks()) track.stop()
    this.onRemoteStream?.(connId, null)
    this.onRemoteScreen?.(connId, null)
    this.stopSpeakingDetection(connId)
  }

  private emitRemote(connId: string, peer: Peer) {
    this.onRemoteStream?.(connId, peer.stream.getVideoTracks().length ? peer.stream : null)
    this.onRemoteScreen?.(
      connId,
      peer.screenStream.getVideoTracks().length ? peer.screenStream : null,
    )
  }

  // Called by the store when a participant's advertised screen msid changes. Sets
  // the peer's screenStreamId and reclassifies any track that arrived before the
  // metadata (in either direction), then re-emits.
  updateRemoteScreen(connId: string, streamId: string | null) {
    const peer = this.peers.get(connId)
    if (!peer) return
    peer.screenStreamId = streamId
    for (const track of [...peer.stream.getTracks(), ...peer.screenStream.getTracks()]) {
      const origin = peer.trackOrigins.get(track.id) ?? null
      const shouldBeScreen = streamId !== null && origin === streamId
      const inScreen = peer.screenStream.getTracks().some((t) => t.id === track.id)
      if (shouldBeScreen && !inScreen) {
        peer.stream.removeTrack(track)
        peer.screenStream.addTrack(track)
      } else if (!shouldBeScreen && inScreen) {
        peer.screenStream.removeTrack(track)
        peer.stream.addTrack(track)
      }
    }
    this.emitRemote(connId, peer)
  }

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
    this.pendingScreen = true
    videoTrack.addEventListener('ended', this.handleScreenEnded, { once: true })
    return stream.id
  }

  publishScreen() {
    const stream = this.screenStream
    if (this.stopped || !stream) return
    this.pendingScreen = false
    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) {
        const sender = peer.pc.addTrack(track, stream)
        if (track.kind === 'video') void configureScreenSender(sender)
      }
    }
    this.onLocalScreen?.(stream)
  }

  stopScreenShare() {
    const stream = this.screenStream
    if (!stream) return
    this.screenStream = null
    this.pendingScreen = false
    const trackIds = new Set(stream.getTracks().map((track) => track.id))
    for (const track of stream.getTracks()) {
      track.removeEventListener('ended', this.handleScreenEnded)
    }
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) {
        if (sender.track && trackIds.has(sender.track.id)) peer.pc.removeTrack(sender)
      }
    }
    for (const track of stream.getTracks()) track.stop()
    this.onLocalScreen?.(null)
  }

  setMuted(muted: boolean) {
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted
    }
  }

  stop() {
    if (this.stopped) return
    this.stopped = true

    this.stopCamera()
    this.stopScreenShare()
    for (const connId of [...this.peers.keys()]) this.removePeer(connId)
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

  private sendSignal(
    toUser: string,
    toConn: string,
    kind: VoiceSignalPayload['kind'],
    data: object,
  ) {
    this.send('voice.signal', {
      channel_id: this.channelId,
      to_user: toUser,
      to_conn: toConn,
      kind,
      data,
    })
  }

  private async flushCandidates(peer: Peer) {
    const pending = peer.pendingCandidates.splice(0)
    for (const candidate of pending) {
      try {
        await peer.pc.addIceCandidate(candidate)
      } catch (error) {
        if (!peer.ignoreOffer) throw error
      }
    }
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

async function configureVideoSender(sender: RTCRtpSender, maxBitrate: number) {
  try {
    const parameters = sender.getParameters()
    if (!parameters.encodings.length) parameters.encodings.push({})
    parameters.encodings[0].maxBitrate = maxBitrate
    await sender.setParameters(parameters)
  } catch (error) {
    console.warn('Could not apply camera bitrate limit', error)
  }
}

async function configureScreenSender(sender: RTCRtpSender) {
  try {
    const parameters = sender.getParameters()
    if (!parameters.encodings.length) parameters.encodings.push({})
    parameters.encodings[0].maxBitrate = SCREEN_MAX_BITRATE
    parameters.degradationPreference = 'maintain-resolution'
    await sender.setParameters(parameters)
  } catch (error) {
    console.warn('Could not apply screen share bitrate limit', error)
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

// Camera quality tiers. Plain camera stays at 360p to keep mesh upload cheap;
// background effects capture at 720p because the composited output is upscaled
// hard on the stage and 360p input makes the whole frame look soft.
function cameraQuality(highRes: boolean): MediaTrackConstraints {
  return highRes
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } }
    : { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 } }
}

function videoConstraints(deviceId?: string | null, highRes = false): MediaTrackConstraints {
  const base = cameraQuality(highRes)
  if (deviceId) return { ...base, deviceId: { exact: deviceId } }
  return { ...base, facingMode: 'user' }
}
