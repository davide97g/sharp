import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

export type IconButtonSize = 'sm' | 'md' | 'lg' | 'xl'
export type IconButtonVariant = 'ghost' | 'accent' | 'danger'
export type IconButtonShape = 'square' | 'circle'

const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center outline-none transition ' +
  'focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-50'

const sizes: Record<IconButtonSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10',
  xl: 'h-11 w-11',
}

const variants: Record<IconButtonVariant, string> = {
  ghost: 'text-text-faint hover:bg-panel-2 hover:text-text',
  accent: 'bg-accent text-white hover:bg-accent-hover',
  danger: 'text-danger-fg hover:bg-danger-soft',
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — becomes both aria-label and the native title tooltip. */
  label: string
  size?: IconButtonSize
  variant?: IconButtonVariant
  shape?: IconButtonShape
  /** adds the `.micro-icon-button` spring-hover class */
  micro?: boolean
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', variant = 'ghost', shape = 'square', micro, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        base,
        sizes[size],
        variants[variant],
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        micro && 'micro-icon-button',
        className,
      )}
      {...rest}
    />
  )
})
