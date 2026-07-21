import { useStore } from '../store'
import type { Channel } from './types'
import { channelLabel } from './util'

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
      nicknames: s.nicknames,
      users: s.users,
      fallback: fallback ?? null,
    }),
  )
}

/** Live channel label (DM nicknames apply). */
export function useChannelLabel(ch: Channel | null | undefined): string {
  const nicknames = useStore((s) => s.nicknames)
  if (!ch) return ''
  return channelLabel(ch, nicknames)
}
