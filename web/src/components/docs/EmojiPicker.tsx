import { useEffect, useRef, useState } from 'react'

const EMOJIS = [
  '📄', '📝', '📘', '📗', '📙', '📕', '📓', '📔', '📚', '🗂️',
  '📋', '📌', '📎', '🔖', '🏷️', '💡', '✅', '⭐', '🔥', '🚀',
  '🎯', '📊', '📈', '📉', '🗺️', '🧭', '⚙️', '🛠️', '🔧', '🧩',
  '💬', '📣', '🔔', '📅', '⏰', '🧠', '❤️', '⚡', '🌟', '🎨',
  '🏗️', '🔬', '🧪', '🐛', '🔒', '🌐', '📦', '🎉', '☕', '🍀',
]

export function EmojiPicker({
  value,
  disabled,
  onChange,
}: {
  value: string
  disabled?: boolean
  onChange: (icon: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={disabled ? undefined : 'Change icon'}
        className={`flex h-11 w-11 items-center justify-center rounded-lg text-3xl ${
          disabled ? '' : 'hover:bg-[var(--color-panel-2)]'
        }`}
      >
        {value || '📄'}
      </button>
      {open && !disabled && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-2 shadow-2xl">
          <div className="grid grid-cols-8 gap-0.5">
            {EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => {
                  onChange(e)
                  setOpen(false)
                }}
                className="flex h-7 w-7 items-center justify-center rounded text-lg hover:bg-[var(--color-panel-2)]"
              >
                {e}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onChange('')
              setOpen(false)
            }}
            className="mt-1.5 w-full rounded-md px-2 py-1 text-left text-xs text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)]"
          >
            Remove icon
          </button>
        </div>
      )}
    </div>
  )
}
