import { useStore } from '../store'

export function TypingRow({ channelId }: { channelId: string }) {
  const typing = useStore((s) => s.typing[channelId])
  const names = typing ? Object.values(typing).map((t) => t.display_name) : []

  const text = (() => {
    if (names.length === 0) return ''
    if (names.length === 1) return `${names[0]} is typing…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
    return `${names.length} people are typing…`
  })()

  return (
    <div className="h-5 px-5 text-xs text-[var(--color-text-faint)]">
      {text && (
        <span className="flex items-center gap-1.5">
          <span className="flex gap-0.5">
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>
          {text}
        </span>
      )}
    </div>
  )
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block h-1 w-1 animate-bounce rounded-full bg-[var(--color-text-faint)]"
      style={{ animationDelay: `${delay}ms`, animationDuration: '1s' }}
    />
  )
}
