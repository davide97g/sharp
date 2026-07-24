import { forwardRef, type SelectHTMLAttributes } from 'react'
import { cn } from './cn'
import { fieldChrome, surfaces, type FieldSize, type FieldSurface } from './Input'

const sizes: Record<FieldSize, string> = {
  sm: 'px-2 py-1.5',
  md: 'px-3 py-2',
  lg: 'min-h-11 px-3 py-2.5 text-base sm:text-sm',
}

const invalidChrome = 'border-danger focus:border-danger focus:ring-danger-soft'

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  uiSize?: FieldSize
  surface?: FieldSurface
  invalid?: boolean
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { uiSize = 'md', surface = 'panel-2', invalid, className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldChrome, surfaces[surface], sizes[uiSize], invalid && invalidChrome, className)}
      {...rest}
    >
      {children}
    </select>
  )
})
