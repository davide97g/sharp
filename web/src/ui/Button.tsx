import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const base =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-semibold outline-none transition ' +
  'focus-visible:ring-2 focus-visible:ring-accent active:scale-[0.98] ' +
  'disabled:cursor-default disabled:opacity-50 disabled:active:scale-100'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  outline: 'border border-border text-text-dim hover:bg-panel-2 hover:text-text',
  ghost: 'text-text-dim hover:bg-panel-2 hover:text-text',
  danger: 'bg-danger text-white hover:bg-danger-hover focus-visible:ring-danger-fg',
}

const sizes: Record<ButtonSize, string> = {
  xs: 'rounded-md px-2.5 py-1 text-xs',
  sm: 'rounded-md px-3 py-1.5 text-sm',
  md: 'rounded-lg px-3 py-2 text-sm',
  lg: 'min-h-11 rounded-lg px-4 py-2.5 text-base sm:text-sm',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** rounded-full instead of the size's radius */
  pill?: boolean
  /** w-full */
  block?: boolean
  /** shows a spinner and disables the button, keeping its width stable */
  loading?: boolean
  iconLeft?: ReactNode
  iconRight?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', pill, block, loading, iconLeft, iconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(base, variants[variant], sizes[size], pill && 'rounded-full', block && 'w-full', className)}
      {...rest}
    >
      {loading ? <Spinner size="sm" className={variant === 'primary' || variant === 'danger' ? 'border-white/30 border-t-white' : undefined} /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  )
})
