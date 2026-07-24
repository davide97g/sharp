import type { ReactNode } from 'react'
import { cn } from './cn'

export function Divider({ label, className }: { label?: ReactNode; className?: string }) {
  if (!label) return <div className={cn('h-px bg-border', className)} />
  return (
    <div className={cn('flex items-center gap-3', className)}>
      <div className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border bg-ink px-3 py-0.5 text-xs font-medium text-text-dim">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  )
}
