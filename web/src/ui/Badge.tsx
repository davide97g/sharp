import type { ReactNode } from 'react'
import { cn } from './cn'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type BadgeVariant = 'soft' | 'solid' | 'outline'

const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-semibold leading-none'

const soft: Record<BadgeTone, string> = {
  neutral: 'bg-panel-2 text-text-dim',
  accent: 'bg-accent-soft text-accent-hover',
  success: 'bg-success-soft text-success-fg',
  warning: 'bg-warning-soft text-warning-fg',
  danger: 'bg-danger-soft text-danger-fg',
}

const solid: Record<BadgeTone, string> = {
  neutral: 'bg-panel-2 text-text',
  accent: 'bg-accent text-white',
  success: 'bg-success text-white',
  warning: 'bg-warning text-white',
  danger: 'bg-danger text-white',
}

const outline: Record<BadgeTone, string> = {
  neutral: 'border border-border text-text-dim',
  accent: 'border border-accent-hover/40 text-accent-hover',
  success: 'border border-success-fg/40 text-success-fg',
  warning: 'border border-warning-fg/40 text-warning-fg',
  danger: 'border border-danger-fg/40 text-danger-fg',
}

const byVariant: Record<BadgeVariant, Record<BadgeTone, string>> = { soft, solid, outline }

export interface BadgeProps {
  tone?: BadgeTone
  variant?: BadgeVariant
  uppercase?: boolean
  className?: string
  children: ReactNode
}

export function Badge({ tone = 'neutral', variant = 'soft', uppercase, className, children }: BadgeProps) {
  return (
    <span className={cn(base, byVariant[variant][tone], uppercase && 'uppercase tracking-wide', className)}>
      {children}
    </span>
  )
}

export interface CountBadgeProps {
  count: number
  max?: number
  muted?: boolean
  className?: string
}

export function CountBadge({ count, max = 99, muted, className }: CountBadgeProps) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-3xs font-bold leading-none',
        muted ? 'bg-accent-soft text-accent-hover' : 'bg-accent text-white',
        className,
      )}
    >
      {count > max ? `${max}+` : count}
    </span>
  )
}
