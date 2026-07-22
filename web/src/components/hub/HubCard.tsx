import { Avatar } from '../Avatar'

export function HubCard({
  icon,
  title,
  preview,
  channel,
  updatedAt,
  creatorId,
  creatorName,
  onOpen,
  onChannel,
}: {
  icon: React.ReactNode
  title: string
  preview?: string
  channel?: string
  updatedAt?: string
  creatorId?: string | null
  creatorName?: string
  onOpen: () => void
  onChannel?: () => void
}) {
  return (
    <button
      onClick={onOpen}
      className="group flex min-h-40 flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4 text-left transition duration-200 hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate font-semibold">{title || 'Untitled'}</span>
      </div>
      {preview && <p className="line-clamp-2 text-sm text-[var(--color-text-dim)]">{preview}</p>}
      <div className="mt-auto flex min-h-5 items-center gap-2 text-[11px] text-[var(--color-text-faint)]">
        {channel && (
          <span
            onClick={(event) => {
              event.stopPropagation()
              onChannel?.()
            }}
            className="max-w-28 truncate text-[var(--color-accent-hover)]"
          >
            #{channel}
          </span>
        )}
        {updatedAt && <span>{updatedAt}</span>}
        {creatorId && <Avatar id={creatorId} name={creatorName ?? 'Creator'} size={18} />}
      </div>
    </button>
  )
}
