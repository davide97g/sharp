import { cn } from './cn'

export type SpinnerSize = 'sm' | 'md' | 'lg'

const sizes: Record<SpinnerSize, string> = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
}

export function Spinner({ size = 'md', className }: { size?: SpinnerSize; className?: string }) {
  return (
    <span
      // className merged last so callers (e.g. Button) can override the border colors.
      className={cn(
        'inline-block animate-spin rounded-full border-2 border-border border-t-accent motion-reduce:animate-none',
        sizes[size],
        className,
      )}
      aria-hidden
    />
  )
}
