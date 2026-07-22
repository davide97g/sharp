export function HubFilters({
  channels,
  selected,
  onToggle,
  onClear,
}: {
  channels: { id: string; name: string }[]
  selected: string[]
  onToggle: (id: string) => void
  onClear: () => void
}) {
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1.5 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
      active
        ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
        : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)]'
    }`

  return (
    <div className="flex flex-wrap gap-2">
      <button onClick={onClear} className={pill(selected.length === 0)}>
        All channels
      </button>
      {channels.map((channel) => (
        <button
          key={channel.id}
          onClick={() => onToggle(channel.id)}
          className={pill(selected.includes(channel.id))}
        >
          #{channel.name}
        </button>
      ))}
    </div>
  )
}
