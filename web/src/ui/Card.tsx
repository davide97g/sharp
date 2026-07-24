import { createElement, type ReactNode } from 'react'
import { cn } from './cn'

export type CardPadding = 'none' | 'sm' | 'md' | 'lg'
export type CardAs = 'div' | 'button' | 'a' | 'section'

const paddings: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
}

export interface CardProps {
  interactive?: boolean
  padding?: CardPadding
  as?: CardAs
  className?: string
  children?: ReactNode
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/** Panel surface — the `rounded-xl border bg-panel` card recipe. `interactive`
 *  adds hover/focus affordances (pair with `as="button"`). */
export function Card({ interactive, padding = 'md', as = 'div', className, children, ...rest }: CardProps) {
  return createElement(
    as,
    {
      className: cn(
        'rounded-xl border border-border bg-panel',
        paddings[padding],
        interactive &&
          'cursor-pointer text-left outline-none transition hover:border-accent hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-accent',
        className,
      ),
      ...rest,
    },
    children,
  )
}
