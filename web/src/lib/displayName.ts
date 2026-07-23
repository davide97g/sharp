import { useStore, streamingActive } from '../store'
import type { Channel } from './types'
import { channelLabel } from './util'

const EMPTY_NICKNAMES: Record<string, string> = {}

/**
 * The nicknames map for display, honoring the streaming-mode "show plain names"
 * setting. Gated on streaming itself (not the shield): pausing the shield to
 * reveal messages must NOT bring personal nicknames back while the screen is
 * still being shared. Never touches the stored map.
 */
export function effectiveNicknames(s: {
  nicknames: Record<string, string>
  streamRevertNicknames: boolean
  streamManual: boolean
  voice: { screenStatus: 'off' | 'starting' | 'on' }
}): Record<string, string> {
  return s.streamRevertNicknames && streamingActive(s) ? EMPTY_NICKNAMES : s.nicknames
}

/** Resolve a user's name for the current viewer (nickname → directory → fallback). */
export function displayNameFor(
  userId: string | null | undefined,
  opts: {
    nicknames?: Record<string, string>
    users?: Record<string, { display_name: string }>
    fallback?: string | null
  } = {},
): string {
  if (!userId) return opts.fallback?.trim() || 'Unknown'
  const nick = opts.nicknames?.[userId]?.trim()
  if (nick) return nick
  const fromDir = opts.users?.[userId]?.display_name?.trim()
  if (fromDir) return fromDir
  return opts.fallback?.trim() || 'Unknown'
}

/** Live display name for a user id (subscribes to nicknames + directory). */
export function useDisplayName(userId: string | null | undefined, fallback?: string | null): string {
  return useStore((s) =>
    displayNameFor(userId, {
      nicknames: effectiveNicknames(s),
      users: s.users,
      fallback: fallback ?? null,
    }),
  )
}

/** Live channel label (DM nicknames apply). */
export function useChannelLabel(ch: Channel | null | undefined): string {
  const nicknames = useStore(effectiveNicknames)
  if (!ch) return ''
  return channelLabel(ch, nicknames)
}
