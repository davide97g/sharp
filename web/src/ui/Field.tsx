import type { ReactNode } from 'react'

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  /** When set, renders a <div> + real <label htmlFor> instead of a wrapping <label>. */
  htmlFor?: string
  children: ReactNode
}

export function Field({ label, hint, error, required, htmlFor, children }: FieldProps) {
  const labelSpan = (
    <span className="text-xs font-medium text-text-dim">
      {label}
      {required && <span className="text-danger-fg"> *</span>}
    </span>
  )
  const footer = error ? (
    <span role="alert" className="text-xs text-danger-fg">
      {error}
    </span>
  ) : hint ? (
    <span className="text-2xs text-text-faint">{hint}</span>
  ) : null

  if (htmlFor) {
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={htmlFor}>{labelSpan}</label>
        {children}
        {footer}
      </div>
    )
  }
  return (
    <label className="flex flex-col gap-1.5">
      {labelSpan}
      {children}
      {footer}
    </label>
  )
}
