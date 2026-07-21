import { useEffect, useState } from 'react'
import { avatarColor, initials } from '../lib/util'
import { fetchAttachmentBlob } from '../lib/api'
import { useStore } from '../store'

// The avatar API requires a Bearer header, so <img src> can't load it directly.
// Fetch as an authed blob once per URL and cache the resulting object URL. The
// avatar_url carries a version token, so a changed avatar is a fresh cache key.
const cache = new Map<string, Promise<string>>()
function loadAvatar(url: string): Promise<string> {
  let p = cache.get(url)
  if (!p) {
    p = fetchAttachmentBlob(url).then((b) => URL.createObjectURL(b))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

export function Avatar({
  id,
  name,
  size = 36,
  online,
}: {
  id: string
  name: string
  size?: number
  online?: boolean
}) {
  // Resolve the freshest name/avatar from the directory (and personal nickname)
  // so profile edits reflect live everywhere; fall back to the props for users
  // not in the directory.
  const stored = useStore((s) => s.users[id])
  const nickname = useStore((s) => s.nicknames[id])
  const displayName = nickname?.trim() || stored?.display_name || name
  const avatarUrl = stored?.avatar_url ?? null

  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    setSrc(null)
    if (!avatarUrl) return
    let cancelled = false
    loadAvatar(avatarUrl)
      .then((obj) => !cancelled && setSrc(obj))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [avatarUrl])

  // Soft rounded-square, scaling with size (never a hard square, never a full circle).
  const radius = Math.max(6, Math.round(size * 0.28))

  return (
    <div
      className="user-avatar relative shrink-0"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      {src ? (
        <img
          src={src}
          alt={displayName}
          className="user-avatar-surface h-full w-full object-cover select-none"
          style={{ borderRadius: radius }}
          draggable={false}
        />
      ) : (
        <div
          className="user-avatar-surface flex h-full w-full items-center justify-center font-semibold text-white select-none"
          style={{
            backgroundColor: avatarColor(id),
            fontSize: size * 0.4,
            borderRadius: radius,
          }}
        >
          {initials(displayName)}
        </div>
      )}
      {online !== undefined && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2"
          style={{
            width: size * 0.32,
            height: size * 0.32,
            backgroundColor: online ? '#4fbf9f' : '#4b4b56',
            borderColor: 'var(--color-panel)',
          }}
        />
      )}
    </div>
  )
}
