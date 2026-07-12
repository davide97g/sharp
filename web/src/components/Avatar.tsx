import { avatarColor, initials } from '../lib/util'

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
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div
        className="flex h-full w-full items-center justify-center rounded-md font-semibold text-white select-none"
        style={{
          backgroundColor: avatarColor(id),
          fontSize: size * 0.4,
        }}
      >
        {initials(name)}
      </div>
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
