import { type ReactNode } from 'react'
import { cn } from './cn'

export type BannerTone = 'neutral' | 'accent' | 'warning' | 'danger'

const tones: Record<BannerTone, string> = {
  neutral: 'border-border bg-panel/70 text-text-dim',
  accent: 'border-accent/40 bg-accent-soft/60 text-text',
  warning: 'border-warning-fg/40 bg-warning-soft text-warning-fg',
  danger: 'border-danger-fg/40 bg-danger-soft text-danger-fg',
}

/** Inline status/notice bar (trash, active-call, poll banners). */
export function Banner({
  tone = 'neutral',
  icon,
  actions,
  className,
  children,
}: {
  tone?: BannerTone
  icon?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('flex items-center gap-3 rounded-lg border px-4 py-2.5 text-sm', tones[tone], className)}>
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
