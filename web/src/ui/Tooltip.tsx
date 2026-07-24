import type { ReactNode } from 'react'
import { cn } from './cn'

export interface TooltipProps {
  label: string
  side?: 'top' | 'bottom'
  className?: string
  children: ReactNode
}

/** CSS-driven tooltip — the `.ui-tip[data-tooltip]` rules live in index.css.
 *  Wraps the trigger; reveal is pure CSS on hover/focus-within. */
export function Tooltip({ label, side = 'top', className, children }: TooltipProps) {
  return (
    <span
      className={cn('ui-tip inline-flex', className)}
      data-tooltip={label}
      data-tip={side === 'bottom' ? 'below' : 'above'}
    >
      {children}
    </span>
  )
}
