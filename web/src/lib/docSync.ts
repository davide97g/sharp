import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import { getToken, resolveBaseUrl } from './api'

// 'closed' is terminal: the server refused the socket (403/404 on upgrade —
// access revoked or doc permanently deleted) enough times that we stopped
// retrying. Distinct from 'offline', which keeps reconnecting.
export type DocConnStatus = 'connecting' | 'connected' | 'offline' | 'closed'
export type DocRoleByte = 'viewer' | 'editor'

// Consecutive failed upgrades (never reached `open`) before we give up and
// declare the socket terminally closed.
const MAX_UPGRADE_FAILURES = 3

// Binary frame types (first byte of every frame). Mirrors the server contract.
const FRAME_UPDATE = 0x00
const FRAME_AWARENESS = 0x01
const FRAME_INIT = 0x02
const FRAME_STATE_VECTOR = 0x03
const FRAME_ROLE = 0x04

type ProviderOpts = {
  docId: string
  doc: Y.Doc
  user: { name: string; color: string }
  onStatus?: (status: DocConnStatus) => void
  onRole?: (role: DocRoleByte) => void
}

/**
 * Yjs sync provider for a sharp doc, speaking the binary frame protocol over
 * `${base}/api/v1/docs/{id}/sync?token=...`. Exposes a `y-protocols` Awareness
 * instance for BlockNote's `collaboration.provider`.
 *
 * Mirrors the reconnect/backoff patterns of `WsClient` (see lib/ws.ts).
 */
export class SharpDocProvider {
  readonly doc: Y.Doc
  readonly awareness: Awareness

  private docId: string
  private user: { name: string; color: string }
  private ws: WebSocket | null = null
  private closedByUser = false
  private attempt = 0
  // Counts upgrades that failed before the socket ever opened. Reset to 0 on a
  // successful open; when it reaches MAX_UPGRADE_FAILURES we stop reconnecting.
  private upgradeFailures = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private status: DocConnStatus = 'connecting'
  private onStatus?: (status: DocConnStatus) => void
  private onRole?: (role: DocRoleByte) => void

  private readonly docUpdateHandler: (update: Uint8Array, origin: unknown) => void
  private readonly awarenessUpdateHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void

  constructor(opts: ProviderOpts) {
    this.docId = opts.docId
    this.doc = opts.doc
    this.user = opts.user
    this.onStatus = opts.onStatus
    this.onRole = opts.onRole

    this.awareness = new Awareness(this.doc)
    this.awareness.setLocalStateField('user', {
      name: this.user.name,
      color: this.user.color,
    })

    // Local doc changes (origin !== this) are forwarded to the server.
    this.docUpdateHandler = (update, origin) => {
      if (origin === this) return
      this.sendFrame(FRAME_UPDATE, update)
    }
    // Local awareness changes (origin !== this) are forwarded to the server.
    this.awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
      if (origin === this) return
      const changed = [...added, ...updated, ...removed]
      const payload = encodeAwarenessUpdate(this.awareness, changed)
      this.sendFrame(FRAME_AWARENESS, payload)
    }

    this.doc.on('update', this.docUpdateHandler)
    this.awareness.on('update', this.awarenessUpdateHandler)
  }

  private wsUrl(): string {
    const base = resolveBaseUrl()
    const wsBase = base.replace(/^http/, 'ws')
    const token = getToken() ?? ''
    return `${wsBase}/api/v1/docs/${this.docId}/sync?token=${encodeURIComponent(token)}`
  }

  private setStatus(status: DocConnStatus) {
    if (this.status === status) return
    this.status = status
    this.onStatus?.(status)
  }

  /**
   * Open the socket (idempotent). Reversible with {@link disconnect}, so the
   * same provider survives React StrictMode's mount→unmount→mount cycle.
   */
  connect() {
    this.closedByUser = false
    this.upgradeFailures = 0
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.open()
  }

  /**
   * Terminal close: the server keeps rejecting the upgrade (access revoked or
   * doc permanently deleted). Stop reconnecting and surface 'closed' so the UI
   * can show an access-lost state. Reversible only via a fresh {@link connect}.
   */
  private terminate() {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws = null
    this.setStatus('closed')
  }

  /** Close the socket but keep the provider reusable (listeners/awareness intact). */
  disconnect() {
    this.closedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* noop */
      }
      this.ws = null
    }
    this.setStatus('offline')
  }

  private open() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.setStatus('connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // Per-attempt flag: did this socket ever reach the open state? A close
    // without an open means the upgrade itself was rejected (403/404/network).
    let opened = false

    ws.onopen = () => {
      // Ignore events from a socket we've already superseded (e.g. a
      // StrictMode disconnect→reconnect replaced `this.ws` before this fired).
      if (this.ws !== ws) return
      opened = true
      this.attempt = 0
      this.upgradeFailures = 0
      // Announce our presence so already-connected peers see us immediately.
      const payload = encodeAwarenessUpdate(this.awareness, [this.doc.clientID])
      this.sendFrame(FRAME_AWARENESS, payload)
    }

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return
      if (!(ev.data instanceof ArrayBuffer)) return
      this.handleFrame(new Uint8Array(ev.data))
    }

    ws.onclose = () => {
      // A superseded socket (disconnect() nulled/replaced `this.ws`) closing
      // must not clobber the live connection or schedule a stray reconnect.
      if (this.ws !== ws) return
      this.ws = null
      if (this.closedByUser) {
        this.setStatus('offline')
        return
      }
      // A close before the socket ever opened is an upgrade rejection. After a
      // few in a row we assume access was lost / the doc is gone and stop.
      if (!opened) {
        this.upgradeFailures += 1
        if (this.upgradeFailures >= MAX_UPGRADE_FAILURES) {
          this.terminate()
          return
        }
      }
      this.setStatus('offline')
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
  }

  private handleFrame(frame: Uint8Array) {
    if (frame.length === 0) return
    const type = frame[0]
    const payload = frame.subarray(1)
    switch (type) {
      case FRAME_ROLE: {
        const role: DocRoleByte = payload[0] === 1 ? 'editor' : 'viewer'
        this.onRole?.(role)
        break
      }
      case FRAME_INIT: {
        // Merged doc state; applied with origin=this so we don't echo it back.
        Y.applyUpdate(this.doc, payload, this)
        break
      }
      case FRAME_STATE_VECTOR: {
        // Server's state vector: reply with anything it lacks (offline edits).
        const diff = Y.encodeStateAsUpdate(this.doc, payload)
        // An "empty" v1 update encodes to 2 bytes ([0,0]); only send real diffs.
        if (diff.length > 2) this.sendFrame(FRAME_UPDATE, diff)
        this.setStatus('connected')
        break
      }
      case FRAME_UPDATE: {
        Y.applyUpdate(this.doc, payload, this)
        break
      }
      case FRAME_AWARENESS: {
        applyAwarenessUpdate(this.awareness, payload, this)
        break
      }
      default:
        break
    }
  }

  private sendFrame(type: number, payload: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const frame = new Uint8Array(payload.length + 1)
    frame[0] = type
    frame.set(payload, 1)
    try {
      this.ws.send(frame)
    } catch {
      /* noop */
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser) return
    this.attempt += 1
    const backoff = Math.min(1000 * 2 ** (this.attempt - 1), 30000)
    const jitter = Math.random() * 0.3 * backoff
    this.reconnectTimer = setTimeout(() => this.open(), backoff + jitter)
  }

  /** Terminal teardown: notify peers we left, detach listeners, close socket. */
  destroy() {
    // Broadcast our departure (fires awarenessUpdateHandler while ws still open).
    try {
      removeAwarenessStates(this.awareness, [this.doc.clientID], 'local')
    } catch {
      /* noop */
    }
    this.disconnect()
    this.doc.off('update', this.docUpdateHandler)
    this.awareness.off('update', this.awarenessUpdateHandler)
    this.awareness.destroy()
  }
}
