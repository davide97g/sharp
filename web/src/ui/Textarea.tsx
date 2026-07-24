import { forwardRef, type TextareaHTMLAttributes } from 'react'
import { cn } from './cn'
import { fieldChrome, surfaces, type FieldSize, type FieldSurface } from './Input'

const sizes: Record<FieldSize, string> = {
  sm: 'px-2.5 py-1.5',
  md: 'px-3 py-2',
  lg: 'min-h-11 px-3 py-2.5 text-base sm:text-sm',
}

const invalidChrome = 'border-danger focus:border-danger focus:ring-danger-soft'

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  uiSize?: FieldSize
  surface?: FieldSurface
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { uiSize = 'md', surface = 'panel-2', invalid, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(fieldChrome, 'resize-y', surfaces[surface], sizes[uiSize], invalid && invalidChrome, className)}
      {...rest}
    />
  )
})
