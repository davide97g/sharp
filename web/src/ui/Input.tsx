import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

export type FieldSize = 'sm' | 'md' | 'lg'
export type FieldSurface = 'panel-2' | 'panel'

/** Canonical field chrome shared by Input/Textarea/Select. */
export const fieldChrome =
  'w-full rounded-lg border border-border text-sm text-text placeholder:text-text-faint ' +
  'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

export const surfaces: Record<FieldSurface, string> = {
  'panel-2': 'bg-panel-2',
  panel: 'bg-panel',
}

const sizes: Record<FieldSize, string> = {
  sm: 'px-2.5 py-1.5',
  md: 'px-3 py-2',
  lg: 'min-h-11 px-3 py-2.5 text-base sm:text-sm',
}

const invalidChrome = 'border-danger focus:border-danger focus:ring-danger-soft'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  uiSize?: FieldSize
  surface?: FieldSurface
  invalid?: boolean
  /** Rendered inside the focus-within group, before a borderless inner input. */
  prefix?: ReactNode
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { uiSize = 'md', surface = 'panel-2', invalid, prefix, className, ...rest },
  ref,
) {
  if (prefix != null) {
    // The wrapper carries the chrome + focus-within ring; the inner input is
    // transparent and borderless. The ref still reaches the input element.
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-lg border border-border text-sm text-text',
          'focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-soft',
          surfaces[surface],
          sizes[uiSize],
          invalid && 'border-danger focus-within:border-danger focus-within:ring-danger-soft',
          className,
        )}
      >
        <span className="text-text-faint">{prefix}</span>
        <input
          ref={ref}
          aria-invalid={invalid || undefined}
          className="min-w-0 flex-1 bg-transparent placeholder:text-text-faint focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
          {...rest}
        />
      </div>
    )
  }
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldChrome, surfaces[surface], sizes[uiSize], invalid && invalidChrome, className)}
      {...rest}
    />
  )
})
