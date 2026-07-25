// Pure predicates over store state: Do-Not-Disturb and the streaming privacy shield.
//
// Contract: docs/arch/05-files-notifications.md (DND) and the privacy section there.
//
// They take the narrowest slice they can rather than the whole `State`, so a component
// can call them with a `useStore` selector result and re-render only on what matters.
// Re-exported from store.ts, which is where every caller imports them from.

import type { Channel } from '../types'

export function dndActive(s: {
  dnd: boolean
  dndScheduled: boolean
  dndStart: number | null
  dndEnd: number | null
}): boolean {
  if (s.dnd) return true
  if (!s.dndScheduled || s.dndStart == null || s.dndEnd == null) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const { dndStart: a, dndEnd: b } = s
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

/** Streaming mode is on: manual toggle, or actively sharing the screen in a call. */
export function streamingActive(s: {
  streamManual: boolean
  voice: { screenStatus: 'off' | 'starting' | 'on' }
}): boolean {
  return s.streamManual || s.voice.screenStatus === 'on'
}

type StreamShieldState = {
  streamManual: boolean
  streamRevealAllUntil: number | null
  streamRevealChannels: Record<string, number>
  voice: { screenStatus: 'off' | 'starting' | 'on' }
}

/** The privacy shield is enforcing right now (streaming and not inside an "everything" reveal window). */
export function streamShieldOn(s: StreamShieldState): boolean {
  if (!streamingActive(s)) return false
  return !(s.streamRevealAllUntil && Date.now() < s.streamRevealAllUntil)
}

/**
 * Whether this channel's content must stay hidden right now. A per-channel
 * reveal window lifts the shield for that conversation only; no channel id
 * (e.g. local encrypted-DM search hits) stays hidden while the shield is on.
 */
export function streamChannelShielded(
  s: StreamShieldState,
  channelId: string | null | undefined,
): boolean {
  if (!streamShieldOn(s)) return false
  if (!channelId) return true
  const until = s.streamRevealChannels[channelId]
  return !(until && Date.now() < until)
}

/**
 * Alerts from this channel must stay off-screen while shielded (private/DM only,
 * honoring per-channel reveal windows). Server web-push fires outside the app
 * and can't be gated here — this covers in-app toasts, sounds, and
 * client-routed OS notifications only.
 */
export function streamShieldsChannel(
  st: StreamShieldState & { channels: Channel[] },
  channelId: string | null | undefined,
): boolean {
  if (!channelId) return false
  const kind = st.channels.find((c) => c.id === channelId)?.kind
  if (kind !== 'private' && kind !== 'dm') return false
  return streamChannelShielded(st, channelId)
}
