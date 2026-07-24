import { createElement, type ElementType, type ReactNode } from 'react'
import { cn } from './cn'

export type SectionLabelTone = 'faint' | 'accent'
export type SectionLabelSize = 'xs' | '2xs' | '3xs'

const tones: Record<SectionLabelTone, string> = {
  faint: 'text-text-faint',
  accent: 'text-accent-hover',
}

const sizes: Record<SectionLabelSize, string> = {
  xs: 'text-xs',
  '2xs': 'text-2xs',
  '3xs': 'text-3xs',
}

export interface SectionLabelProps {
  tone?: SectionLabelTone
  size?: SectionLabelSize
  as?: ElementType
  className?: string
  children: ReactNode
}

export function SectionLabel({
  tone = 'faint',
  size = '2xs',
  as = 'h3',
  className,
  children,
}: SectionLabelProps) {
  return createElement(
    as,
    { className: cn('font-semibold uppercase tracking-wider', tones[tone], sizes[size], className) },
    children,
  )
}
