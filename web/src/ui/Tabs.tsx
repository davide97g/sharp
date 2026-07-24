import { type ReactNode } from 'react'
import { cn } from './cn'

export interface TabItem {
  key: string
  label: ReactNode
  badge?: ReactNode
}

/** Underline tab strip (ChannelTabs pattern). */
export function Tabs({
  items,
  active,
  onChange,
  className,
}: {
  items: TabItem[]
  active: string
  onChange: (key: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1 border-b border-border', className)}>
      {items.map((item) => {
        const isActive = item.key === active
        return (
          <button
            key={item.key}
            type="button"
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onChange(item.key)}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-accent',
              isActive
                ? 'border-accent font-medium text-text'
                : 'border-transparent text-text-faint hover:text-text',
            )}
          >
            {item.label}
            {item.badge}
          </button>
        )
      })}
    </div>
  )
}
