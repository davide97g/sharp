import { type ReactNode } from 'react'
import { cn } from './cn'

export type ChoiceCardStyle = 'ring' | 'fill'

/**
 * A selectable radio-style card (ThemeCard / LayoutCard / VisibilityOption).
 * `children` render as an optional preview block above the title/description.
 */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  description,
  selectedStyle = 'ring',
  disabled,
  className,
  children,
}: {
  selected: boolean
  onSelect: () => void
  title: ReactNode
  description?: ReactNode
  selectedStyle?: ChoiceCardStyle
  disabled?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'w-full rounded-xl border p-2 text-left outline-none transition focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-50',
        selected
          ? selectedStyle === 'fill'
            ? 'border-accent bg-accent-soft'
            : 'border-accent ring-2 ring-accent-soft'
          : 'border-border hover:border-text-faint',
        className,
      )}
    >
      {children}
      <div className={cn('text-sm font-semibold text-text', children != null && 'mt-2')}>{title}</div>
      {description && <div className="text-2xs text-text-faint">{description}</div>}
    </button>
  )
}
