import { getToken, resolveBaseUrl } from './api'
export type { WsEnvelope } from './types'
import type { WsEnvelope } from './types'

type Handler = (env: WsEnvelope) => void

/**
 * WebSocket client to `${base}/api/v1/ws?token=...`.
 * - http(s) -> ws(s) scheme rewrite
 * - auto-reconnect with exponential backoff + jitter
 * - dispatches typed envelopes to a single handler
 * - fires onReconnect after a *successful* re-open (not the first open)
 * - buffers sends made while the socket is still opening (see `send`)
 */
export class WsClient {
  private ws: WebSocket | null = null
  private handler: Handler
  private onReconnect: () => void
  private onOpen: () => void
  private closedByUser = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private hasConnectedOnce = false
  private visibilityListenersAttached = false
  /** Frames sent while the socket was CONNECTING, flushed in order on open. */
  private pending: string[] = []

  constructor(opts: {
    handler: Handler
    onReconnect?: () => void
    onOpen?: () => void
  }) {
    this.handler = opts.handler
    this.onReconnect = opts.onReconnect ?? (() => {})
    this.onOpen = opts.onOpen ?? (() => {})
  }

  private wsUrl(): string {
    const base = resolveBaseUrl()
    const wsBase = base.replace(/^http/, 'ws')
    const token = getToken() ?? ''
    return `${wsBase}/api/v1/ws?token=${encodeURIComponent(token)}`
  }

  connect() {
    this.closedByUser = false
    this.attachVisibilityListeners()
    this.open()
  }

  private open() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    let ws: WebSocket
    try {
      ws = new WebSocket(this.wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      const queued = this.pending
      this.pending = []
      for (const frame of queued) ws.send(frame)
      this.startPing()
      this.sendVisibility()
      this.onOpen()
      if (this.hasConnectedOnce) {
        this.onReconnect()
      }
      this.hasConnectedOnce = true
    }

    ws.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as WsEnvelope
        if (env && typeof env.type === 'string') {
          this.handler(env)
        }
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => {
      this.stopPing()
      this.ws = null
      this.pending = []
      if (!this.closedByUser) this.scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose will follow and handle reconnect
      try {
        ws.close()
      } catch {
        /* noop */
      }
    }
  }

  private scheduleReconnect() {
    if (this.closedByUser) return
    this.attempt += 1
    const backoff = Math.min(1000 * 2 ** (this.attempt - 1), 30000)
    const jitter = Math.random() * 0.3 * backoff
    const delay = backoff + jitter
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  private startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      this.send('ping', {})
      this.sendVisibility()
    }, 25000)
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  /**
   * A send on a socket that is still opening is queued, not dropped. The app
   * bootstraps the socket and its first REST calls in parallel, so a feature
   * that announces itself right after a fetch used to lose that frame whenever
   * the handshake was slower than the fetch — true over TLS behind a proxy,
   * never true on localhost, which is why it only bit in production. The server
   * then held no registration for that connection and silently ignored every
   * later event on it.
   *
   * Only the CONNECTING window is buffered, and the queue is dropped on close:
   * an intent worth replaying seconds later belongs in `onReconnect`, not here.
   */
  send(type: string, payload: unknown) {
    if (!this.ws) return
    const frame = JSON.stringify({ type, payload })
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame)
      return
    }
    // Bounded so a socket that never opens cannot grow the queue without limit.
    if (this.ws.readyState === WebSocket.CONNECTING && this.pending.length < 64) {
      this.pending.push(frame)
    }
  }

  sendTyping(channelId: string) {
    this.send('typing', { channel_id: channelId })
  }

  /**
   * What `app.visibility` reports: is the user *attending* this window, not merely
   * whether the tab is rendered. The distinction matters on desktop — a browser
   * window sitting behind another app keeps `visibilityState === 'visible'` and fires
   * no `visibilitychange`, so a visibility-only signal told the server "they are
   * looking at it" and suppressed the push the user was waiting for. Focus is the
   * signal that actually tracks attention, hence the focus/blur listeners.
   *
   * The Tauri shell is exempt: it shows its own local notification whenever the WS
   * event arrives, so reporting unfocused would double up with APNs.
   */
  private isAttended(): boolean {
    if (document.visibilityState !== 'visible') return false
    if ('__TAURI_INTERNALS__' in window) return true
    return document.hasFocus()
  }

  private sendVisibility = () => {
    this.send('app.visibility', { visible: this.isAttended() })
  }

  private sendHidden = () => {
    this.send('app.visibility', { visible: false })
  }

  private attachVisibilityListeners() {
    if (this.visibilityListenersAttached) return
    document.addEventListener('visibilitychange', this.sendVisibility)
    window.addEventListener('focus', this.sendVisibility)
    window.addEventListener('blur', this.sendVisibility)
    window.addEventListener('pageshow', this.sendVisibility)
    window.addEventListener('pagehide', this.sendHidden)
    this.visibilityListenersAttached = true
  }

  private detachVisibilityListeners() {
    if (!this.visibilityListenersAttached) return
    document.removeEventListener('visibilitychange', this.sendVisibility)
    window.removeEventListener('focus', this.sendVisibility)
    window.removeEventListener('blur', this.sendVisibility)
    window.removeEventListener('pageshow', this.sendVisibility)
    window.removeEventListener('pagehide', this.sendHidden)
    this.visibilityListenersAttached = false
  }

  close() {
    this.closedByUser = true
    this.stopPing()
    this.pending = []
    this.detachVisibilityListeners()
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
  }
}
