import type { ReactNode } from 'react'
import { cn } from './cn'

export function Kbd({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <kbd
      className={cn(
        'rounded border border-border border-b-[#383842] bg-panel-2/75 px-1.5 py-0.5 font-mono text-[0.62rem] leading-none text-text-faint',
        className,
      )}
    >
      {children}
    </kbd>
  )
}
