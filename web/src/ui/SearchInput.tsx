import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'
import { fieldChrome, surfaces } from './Input'

export type SearchInputVariant = 'boxed' | 'palette'

const variants: Record<SearchInputVariant, string> = {
  // boxed = exact Input md recipe on panel-2
  boxed: cn(fieldChrome, surfaces['panel-2'], 'px-3 py-2'),
  palette:
    'w-full border-b border-border bg-transparent px-4 py-3.5 text-sm placeholder:text-text-faint focus:outline-none',
}

export interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  variant?: SearchInputVariant
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput(
  { variant = 'boxed', className, type = 'text', ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cn(variants[variant], className)} {...rest} />
})
