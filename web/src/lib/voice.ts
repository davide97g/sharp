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
}

type Peer = {
  pc: RTCPeerConnection
  remoteUser: string
  audio: HTMLAudioElement
  stream: MediaStream
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

export class VoiceClient {
  private channelId: string
  private myConnId: string
  private myUserId: string
  private iceServers: RTCIceServer[]
  private send: (type: string, payload: unknown) => void
  private onSpeaking?: (connId: string, speaking: boolean) => void
  private onLocalStream?: (stream: MediaStream | null) => void
  private onRemoteStream?: (connId: string, stream: MediaStream | null) => void

  private localStream: MediaStream | null = null
  private cameraTrack: MediaStreamTrack | null = null
  private audioDeviceId: string | null = null
  private videoDeviceId: string | null = null
  private peers = new Map<string, Peer>()
  private audioContext: AudioContext | null = null
  private speakingDetectors = new Map<string, SpeakingDetector>()
  private speakingFrame: number | null = null
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
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.pc.getSenders().find((candidate) => candidate.track?.kind === kind)
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
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.style.display = 'none'
    audio.srcObject = stream
    document.body.appendChild(audio)
    const peer: Peer = {
      pc,
      remoteUser,
      audio,
      stream,
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

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.stopped || this.peers.get(remoteConn) !== peer) return
      this.sendSignal(remoteUser, remoteConn, 'candidate', event.candidate.toJSON())
    }

    pc.ontrack = (event) => {
      if (this.stopped || this.peers.get(remoteConn) !== peer) return
      if (!stream.getTracks().some((track) => track.id === event.track.id)) {
        stream.addTrack(event.track)
      }
      if (event.track.kind === 'audio') this.startSpeakingDetection(remoteConn, stream)
      event.track.addEventListener(
        'ended',
        () => {
          stream.removeTrack(event.track)
          this.onRemoteStream?.(remoteConn, stream.getVideoTracks().length ? stream : null)
        },
        { once: true },
      )
      this.onRemoteStream?.(remoteConn, stream)
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
    for (const track of peer.stream.getTracks()) track.stop()
    this.onRemoteStream?.(connId, null)
    this.stopSpeakingDetection(connId)
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
