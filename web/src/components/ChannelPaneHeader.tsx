import { useStore } from '../store'
import { channelLabel } from '../lib/util'
import { Avatar } from './Avatar'
import type { Channel } from '../lib/types'

// The channel identity row (DM avatar+name or #channel) reused by the docs /
// canvas gallery tabs so they match the chat pane's header. `actions` renders
// on the right (e.g. a "+ New" button).
export function ChannelPaneHeader({
  channel,
  actions,
}: {
  channel: Channel
  actions?: React.ReactNode
}) {
  const online = useStore((s) => s.online)
  const isDm = channel.kind === 'dm'
  const dmOnline = isDm && channel.dm_user ? online.has(channel.dm_user.id) : undefined

  return (
    <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
      <div className="flex min-w-0 items-center gap-2">
        {isDm ? (
          <span className="flex items-center gap-2 font-semibold">
            {channel.dm_user && (
              <Avatar
                id={channel.dm_user.id}
                name={channel.dm_user.display_name}
                size={26}
                online={dmOnline}
              />
            )}
            {channelLabel(channel)}
          </span>
        ) : (
          <span className="flex items-center gap-1 font-semibold">
            <span className="text-[var(--color-text-faint)]">#</span>
            {channel.name}
            {channel.kind === 'private' && (
              <span className="text-[var(--color-text-faint)]" title="Private">
                🔒
              </span>
            )}
          </span>
        )}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  )
}
