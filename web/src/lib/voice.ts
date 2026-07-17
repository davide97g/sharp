import type { VoiceParticipant, VoiceSignalPayload } from './types'

type VoiceClientOpts = {
  channelId: string
  myConnId: string
  myUserId: string
  iceServers: RTCIceServer[]
  send: (type: string, payload: unknown) => void
  onSpeaking?: (connId: string, speaking: boolean) => void
  onLocalStream?: (stream: MediaStream | null) => void
  onRemoteStream?: (connId: string, stream: MediaStream | null) => void
  onLocalScreen?: (stream: MediaStream | null) => void
  onRemoteScreen?: (connId: string, stream: MediaStream | null) => void
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

  constructor(opts: VoiceClientOpts) {
    this.channelId = opts.channelId
    this.myConnId = opts.myConnId
    this.myUserId = opts.myUserId
    this.iceServers = opts.iceServers
    this.send = opts.send
    this.onSpeaking = opts.onSpeaking
    this.onLocalStream = opts.onLocalStream
    this.onRemoteStream = opts.onRemoteStream
    this.onLocalScreen = opts.onLocalScreen
    this.onRemoteScreen = opts.onRemoteScreen
  }

  async start(audioDeviceId?: string | null) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints(audioDeviceId),
    })
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.localStream = stream
    this.audioDeviceId = trackDeviceId(stream.getAudioTracks()[0]) ?? audioDeviceId ?? null
    this.startSpeakingDetection(this.myConnId, stream)
  }

  getAudioDeviceId(): string | null {
    return this.audioDeviceId ?? trackDeviceId(this.localStream?.getAudioTracks()[0])
  }

  getVideoDeviceId(): string | null {
    return this.videoDeviceId ?? trackDeviceId(this.cameraTrack)
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
    const nextTrack = nextStream.getAudioTracks()[0]
    if (!nextTrack) {
      for (const track of nextStream.getTracks()) track.stop()
      throw new Error('No microphone was found.')
    }
    if (this.stopped || !this.localStream) {
      nextTrack.stop()
      return
    }

    const previous = this.localStream.getAudioTracks()[0]
    nextTrack.enabled = previous?.enabled ?? true
    if (previous) {
      this.localStream.removeTrack(previous)
      previous.stop()
    }
    this.localStream.addTrack(nextTrack)
    this.audioDeviceId = trackDeviceId(nextTrack) ?? deviceId
    await this.replaceSenderTrack('audio', nextTrack)
    this.stopSpeakingDetection(this.myConnId)
    this.startSpeakingDetection(this.myConnId, this.localStream)
  }

  async setVideoInput(deviceId: string) {
    if (this.stopped) return
    this.videoDeviceId = deviceId
    if (!this.cameraTrack || !this.localStream) return
    if (deviceId === trackDeviceId(this.cameraTrack)) return

    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(deviceId),
    })
    const nextTrack = cameraStream.getVideoTracks()[0]
    if (!nextTrack) {
      for (const track of cameraStream.getTracks()) track.stop()
      throw new Error('No camera was found.')
    }
    if (this.stopped || !this.localStream || !this.cameraTrack) {
      nextTrack.stop()
      return
    }

    const previous = this.cameraTrack
    previous.removeEventListener('ended', this.handleCameraEnded)
    this.localStream.removeTrack(previous)
    previous.stop()

    this.cameraTrack = nextTrack
    this.videoDeviceId = trackDeviceId(nextTrack) ?? deviceId
    this.localStream.addTrack(nextTrack)
    nextTrack.addEventListener('ended', this.handleCameraEnded, { once: true })
    await this.replaceSenderTrack('video', nextTrack)
    this.onLocalStream?.(this.localStream)
  }

  async startCamera() {
    if (this.stopped || !this.localStream || this.cameraTrack) return
    const cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(this.videoDeviceId),
    })
    const track = cameraStream.getVideoTracks()[0]
    if (!track) {
      for (const mediaTrack of cameraStream.getTracks()) mediaTrack.stop()
      throw new Error('No camera was found.')
    }
    if (this.stopped || !this.localStream) {
      track.stop()
      return
    }

    this.cameraTrack = track
    this.videoDeviceId = trackDeviceId(track) ?? this.videoDeviceId
    this.localStream.addTrack(track)
    track.addEventListener('ended', this.handleCameraEnded, { once: true })
    for (const peer of this.peers.values()) {
      const sender = peer.pc.addTrack(track, this.localStream)
      void configureVideoSender(sender)
    }
    this.onLocalStream?.(this.localStream)
  }

  stopCamera() {
    const track = this.cameraTrack
    if (!track) return
    this.cameraTrack = null
    track.removeEventListener('ended', this.handleCameraEnded)
    this.localStream?.removeTrack(track)
    for (const peer of this.peers.values()) {
      const sender = peer.pc.getSenders().find((candidate) => candidate.track === track)
      if (sender) peer.pc.removeTrack(sender)
    }
    track.stop()
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
          if (kind === 'video') void configureVideoSender(sender)
          return
        }
        if (this.localStream) {
          const added = peer.pc.addTrack(track, this.localStream)
          if (kind === 'video') void configureVideoSender(added)
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
      if (track.kind === 'video') void configureVideoSender(sender)
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
    for (const track of this.localStream?.getTracks() ?? []) track.stop()
    this.localStream = null

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
    if (this.stopped || !this.cameraTrack) return
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
    const context = this.audioContext ?? new AudioContext()
    this.audioContext = context
    void context.resume().catch(() => {})

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

async function configureVideoSender(sender: RTCRtpSender) {
  try {
    const parameters = sender.getParameters()
    if (!parameters.encodings.length) parameters.encodings.push({})
    parameters.encodings[0].maxBitrate = VIDEO_MAX_BITRATE
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

function trackDeviceId(track?: MediaStreamTrack | null): string | null {
  const id = track?.getSettings().deviceId
  return id || null
}

function audioConstraints(deviceId?: string | null): MediaTrackConstraints | true {
  if (!deviceId) return true
  return { deviceId: { exact: deviceId } }
}

function videoConstraints(deviceId?: string | null): MediaTrackConstraints {
  const base: MediaTrackConstraints = {
    width: { ideal: 640 },
    height: { ideal: 360 },
    frameRate: { ideal: 20, max: 24 },
  }
  if (deviceId) return { ...base, deviceId: { exact: deviceId } }
  return { ...base, facingMode: 'user' }
}
