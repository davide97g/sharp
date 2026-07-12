import { getToken, resolveBaseUrl } from './api'
import type { WsEnvelope } from './types'

type Handler = (env: WsEnvelope) => void

/**
 * WebSocket client to `${base}/api/v1/ws?token=...`.
 * - http(s) -> ws(s) scheme rewrite
 * - auto-reconnect with exponential backoff + jitter
 * - dispatches typed envelopes to a single handler
 * - fires onReconnect after a *successful* re-open (not the first open)
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
      this.startPing()
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
    }, 25000)
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  send(type: string, payload: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }))
    }
  }

  sendTyping(channelId: string) {
    this.send('typing', { channel_id: channelId })
  }

  close() {
    this.closedByUser = true
    this.stopPing()
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
