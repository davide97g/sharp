import { createElement, type ReactNode } from 'react'
import { cn } from './cn'

export type ListRowAs = 'button' | 'a' | 'div'
export type ListRowSize = 'sm' | 'md' | 'lg'

const sizes: Record<ListRowSize, string> = {
  sm: 'min-h-9 gap-2 px-2 py-1.5',
  md: 'min-h-11 gap-2 px-2 py-2',
  lg: 'min-h-12 gap-2.5 px-3 py-2.5',
}

export interface ListRowProps {
  as?: ListRowAs
  size?: ListRowSize
  selected?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  className?: string
  children?: ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** The shared sidebar / palette / notification row. */
export function ListRow({
  as = 'button',
  size = 'md',
  selected,
  leading,
  trailing,
  className,
  children,
  ...rest
}: ListRowProps) {
  if (as === 'button' && rest.type === undefined) rest.type = 'button'
  return createElement(
    as,
    {
      className: cn(
        'flex w-full items-center rounded-md text-left text-sm outline-none transition-colors hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent',
        sizes[size],
        selected && 'bg-accent-soft hover:bg-accent-soft',
        className,
      ),
      ...rest,
    },
    <>
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing != null && <span className="ml-auto flex items-center gap-1.5">{trailing}</span>}
    </>,
  )
}
