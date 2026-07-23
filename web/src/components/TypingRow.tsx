import { displayNameFor, effectiveNicknames } from '../lib/displayName'
import { useStore } from '../store'

export function TypingRow({ channelId }: { channelId: string }) {
  const typing = useStore((s) => s.typing[channelId])
  const nicknames = useStore(effectiveNicknames)
  const users = useStore((s) => s.users)
  const names = typing
    ? Object.entries(typing).map(([userId, t]) =>
        displayNameFor(userId, {
          nicknames,
          users,
          fallback: t.display_name,
        }),
      )
    : []

  const text = (() => {
    if (names.length === 0) return ''
    if (names.length === 1) return `${names[0]} is typing…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
    return `${names.length} people are typing…`
  })()

  return (
    <div className="typing-row h-5 px-5 text-xs text-[var(--color-text-faint)]" aria-live="polite">
      {text && (
        <span className="typing-signal flex items-center gap-1.5">
          <span className="typing-dots flex gap-0.5" aria-hidden>
            <Dot />
            <Dot />
            <Dot />
          </span>
          <span className="typing-copy">{text}</span>
        </span>
      )}
    </div>
  )
}

function Dot() {
  return <span className="typing-dot inline-block h-1 w-1 rounded-full" />
}
