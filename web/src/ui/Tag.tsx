import type { ReactNode } from 'react'
import { cn } from './cn'
import { colorOf, type PaletteKey } from '../lib/boardColors'

export type TagShape = 'square' | 'pill'

export interface TagProps {
  colorKey: PaletteKey | string
  /** Render a neutral bordered chip with a colored dot instead of a filled chip. */
  withDot?: boolean
  shape?: TagShape
  className?: string
  children: ReactNode
}

export function Tag({ colorKey, withDot, shape = 'square', className, children }: TagProps) {
  const c = colorOf(colorKey)
  const base = cn(
    'inline-flex max-w-full items-center gap-1 truncate px-1.5 py-0.5 text-2xs font-medium',
    shape === 'pill' ? 'rounded-full' : 'rounded',
    className,
  )
  if (withDot) {
    return (
      <span className={cn(base, 'border border-border text-text-dim')}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c.fg }} />
        {children}
      </span>
    )
  }
  return (
    <span className={base} style={{ backgroundColor: c.bg, color: c.fg }}>
      {children}
    </span>
  )
}
