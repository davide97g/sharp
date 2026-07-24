import { type ReactNode } from 'react'
import { cn } from './cn'

export type EmptyStateVariant = 'centered' | 'dashed' | 'inline'

/**
 * The shared empty / zero-data placeholder. `centered` and `dashed` render the
 * icon chip + title + description + action; `inline` is a compact single line
 * (title only).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'centered',
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  variant?: EmptyStateVariant
  className?: string
}) {
  if (variant === 'inline') {
    return <div className={cn('px-2 py-1.5 text-xs text-text-faint', className)}>{title}</div>
  }

  const outer =
    variant === 'dashed'
      ? 'rounded-xl border border-dashed border-border px-6 py-14 text-center'
      : 'flex flex-col items-center px-6 py-16 text-center'

  return (
    <div className={cn(outer, className)}>
      {icon && (
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-panel-2 text-text-faint ring-1 ring-border">
          {icon}
        </div>
      )}
      <div className="mt-3 text-sm font-medium text-text-dim">{title}</div>
      {description && <div className="mt-1 text-xs text-text-faint">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
