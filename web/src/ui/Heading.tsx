import { createElement, type ElementType, type ReactNode } from 'react'
import { cn } from './cn'

export type HeadingLevel = 1 | 2 | 3

const levels: Record<HeadingLevel, { tag: ElementType; cls: string }> = {
  1: { tag: 'h1', cls: 'text-3xl font-semibold tracking-[-0.04em] text-text sm:text-4xl' },
  2: { tag: 'h2', cls: 'text-lg font-semibold text-text' },
  3: { tag: 'h3', cls: 'text-sm font-semibold text-text' },
}

export interface HeadingProps {
  level?: HeadingLevel
  /** Override the rendered element (defaults to the semantic tag for the level). */
  as?: ElementType
  className?: string
  children: ReactNode
}

export function Heading({ level = 1, as, className, children }: HeadingProps) {
  const { tag, cls } = levels[level]
  return createElement(as ?? tag, { className: cn(cls, className) }, children)
}
