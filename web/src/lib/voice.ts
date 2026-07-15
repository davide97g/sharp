import type { VoiceParticipant, VoiceSignalPayload } from './types'

type VoiceClientOpts = {
  channelId: string
  myConnId: string
  myUserId: string
  iceServers: RTCIceServer[]
  send: (type: string, payload: unknown) => void
  onSpeaking?: (connId: string, speaking: boolean) => void
}

type Peer = {
  pc: RTCPeerConnection
  remoteUser: string
  audio: HTMLAudioElement | null
  pendingCandidates: RTCIceCandidateInit[]
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

export class VoiceClient {
  private channelId: string
  private myConnId: string
  private myUserId: string
  private iceServers: RTCIceServer[]
  private send: (type: string, payload: unknown) => void
  private onSpeaking?: (connId: string, speaking: boolean) => void

  private localStream: MediaStream | null = null
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
  }

  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.localStream = stream
    this.startSpeakingDetection(this.myConnId, stream)
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
    const peer: Peer = {
      pc,
      remoteUser,
      audio: null,
      pendingCandidates: [],
    }
    this.peers.set(remoteConn, peer)

    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream)
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || this.stopped || this.peers.get(remoteConn) !== peer) return
      this.sendSignal(remoteUser, remoteConn, 'candidate', event.candidate.toJSON())
    }

    pc.ontrack = (event) => {
      if (this.stopped || this.peers.get(remoteConn) !== peer || peer.audio) return
      const stream = event.streams[0] ?? new MediaStream([event.track])
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.style.display = 'none'
      audio.srcObject = stream
      document.body.appendChild(audio)
      peer.audio = audio
      this.startSpeakingDetection(remoteConn, stream)
    }

    if (this.myConnId < remoteConn) {
      void this.createAndSendOffer(remoteConn, peer)
    }
  }

  async onSignal(p: VoiceSignalPayload) {
    if (this.stopped || p.to_conn !== this.myConnId || p.channel_id !== this.channelId) return

    this.ensurePeer(p.from_conn, p.from_user)
    const peer = this.peers.get(p.from_conn)
    if (!peer) return

    if (p.kind === 'offer') {
      await peer.pc.setRemoteDescription(p.data as RTCSessionDescriptionInit)
      await this.flushCandidates(peer)
      const answer = await peer.pc.createAnswer()
      await peer.pc.setLocalDescription(answer)
      if (this.stopped || this.peers.get(p.from_conn) !== peer) return
      this.sendSignal(p.from_user, p.from_conn, 'answer', {
        type: answer.type,
        sdp: answer.sdp,
      })
      return
    }

    if (p.kind === 'answer') {
      await peer.pc.setRemoteDescription(p.data as RTCSessionDescriptionInit)
      await this.flushCandidates(peer)
      return
    }

    const candidate = p.data as RTCIceCandidateInit
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate)
      return
    }
    await peer.pc.addIceCandidate(candidate)
  }

  removePeer(connId: string) {
    const peer = this.peers.get(connId)
    if (!peer) return
    this.peers.delete(connId)
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.close()
    peer.audio?.remove()
    peer.audio = null
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

  private async createAndSendOffer(remoteConn: string, peer: Peer) {
    try {
      const offer = await peer.pc.createOffer()
      await peer.pc.setLocalDescription(offer)
      if (this.stopped || this.peers.get(remoteConn) !== peer) return
      this.sendSignal(peer.remoteUser, remoteConn, 'offer', {
        type: offer.type,
        sdp: offer.sdp,
      })
    } catch (error) {
      if (!this.stopped) console.error('Failed to create voice offer', error)
    }
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
      await peer.pc.addIceCandidate(candidate)
    }
  }

  private startSpeakingDetection(connId: string, stream: MediaStream) {
    if (this.stopped || this.speakingDetectors.has(connId)) return
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
