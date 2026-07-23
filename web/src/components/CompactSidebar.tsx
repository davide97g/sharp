import { effectiveNicknames } from '../lib/displayName'
import { useMemo } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useStore, streamShieldOn } from '../store'
import { channelLabel } from '../lib/util'
import { Avatar } from './Avatar'
import { SidebarToggleIcon } from './Sidebar'

/** Collapsed chat-only sidebar. Module hubs never inherit channel navigation. */
export function CompactSidebar({ onToggle }: { onToggle?: () => void }) {
  const channels = useStore((s) => s.channels)
  const nicknames = useStore(effectiveNicknames)
  const online = useStore((s) => s.online)
  const shielded = useStore(streamShieldOn)
  const location = useLocation()
  const active = location.pathname.match(/^\/c\/([^/]+)/)?.[1]
  const items = useMemo(
    () =>
      channels
        .filter((c) => c.is_member)
        .sort((a, b) => channelLabel(a, nicknames).localeCompare(channelLabel(b, nicknames))),
    [channels, nicknames],
  )

  return (
    <aside className="flex h-full w-[4.5rem] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      {onToggle && (
        <div className="flex justify-center border-b border-[var(--color-border)] py-2">
          <button
            type="button"
            onClick={onToggle}
            aria-controls="app-sidebar"
            aria-expanded={false}
            aria-keyshortcuts="\\"
            aria-label="Expand sidebar"
            title="Expand sidebar (\)"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-[var(--color-text-faint)] outline-none hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <SidebarToggleIcon open={false} />
          </button>
        </div>
      )}
      <nav
        aria-label="Chat sidebar"
        className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2 py-3"
      >
        {items.map((channel) =>
          channel.kind === 'dm' && channel.dm_user ? (
            <NavLink
              key={channel.id}
              to={`/c/${channel.id}`}
              aria-label={channelLabel(channel, nicknames)}
              title={shielded ? undefined : channelLabel(channel, nicknames)}
              className={`relative flex h-11 w-11 items-center justify-center rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                active === channel.id
                  ? 'bg-[var(--color-accent-soft)] ring-1 ring-[var(--color-accent)]'
                  : 'hover:bg-[var(--color-panel-2)]'
              }`}
            >
              <span className={shielded ? 'stream-blur' : undefined}>
                <Avatar
                  id={channel.dm_user.id}
                  name={channel.dm_user.display_name}
                  size={32}
                  online={online.has(channel.dm_user.id)}
                />
              </span>
            </NavLink>
          ) : (
            <NavLink
              key={channel.id}
              to={`/c/${channel.id}`}
              aria-label={`#${channel.name}`}
              title={shielded && channel.kind === 'private' ? undefined : `#${channel.name}`}
              className={`flex h-11 w-11 items-center justify-center rounded-xl text-xs font-bold outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                active === channel.id
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)] ring-1 ring-[var(--color-accent)]'
                  : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
              }`}
            >
              <span className={shielded && channel.kind === 'private' ? 'stream-blur' : undefined}>
                #{channel.name.slice(0, 1)}
              </span>
            </NavLink>
          ),
        )}
      </nav>
    </aside>
  )
}
