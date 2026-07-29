import { useState } from 'react'
import { Popover } from '../../ui'

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

  return (
    <Popover
      open={open && !disabled}
      onClose={() => setOpen(false)}
      width="w-64"
      trigger={
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
      }
    >
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
    </Popover>
  )
}
