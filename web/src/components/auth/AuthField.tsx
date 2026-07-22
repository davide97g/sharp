import { useId, useState, type CSSProperties } from 'react'

/**
 * The auth-stage input: visible label, optional hint, inline error announced
 * via role="alert", and a show/hide toggle on password fields. Reuses the
 * `.login-field*` chrome so focus/hover motion matches the rest of the app.
 * Pass `index` to join the step's staggered rise (45ms cadence via --i).
 */
export function AuthField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  autoFocus,
  required,
  error,
  hint,
  index,
  onBlur,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  autoComplete?: string
  autoFocus?: boolean
  required?: boolean
  error?: string
  hint?: string
  index?: number
  onBlur?: () => void
}) {
  const id = useId()
  const errorId = `${id}-error`
  const [revealed, setRevealed] = useState(false)
  const isPassword = type === 'password'
  const inputType = isPassword ? (revealed ? 'text' : 'password') : type

  return (
    <label
      className={`login-field flex flex-col gap-1.5${index !== undefined ? ' auth-rise' : ''}`}
      style={index !== undefined ? ({ '--i': index } as CSSProperties) : undefined}
    >
      <span className="login-field-label text-xs font-medium text-[var(--color-text-dim)]">
        {label}
      </span>
      <span className="relative block">
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          data-invalid={error ? 'true' : undefined}
          className={`login-field-input min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] sm:text-sm ${
            isPassword ? 'pr-11' : ''
          }`}
        />
        {isPassword && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? 'Hide password' : 'Show password'}
            className="absolute right-0.5 top-1/2 flex h-10 w-10 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-[var(--color-text-faint)] transition-colors hover:text-[var(--color-text)]"
          >
            {revealed ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" x2="22" y1="2" y2="22" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            )}
          </button>
        )}
      </span>
      {error ? (
        <span id={errorId} role="alert" className="auth-field-error text-xs">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[11px] text-[var(--color-text-faint)]">{hint}</span>
      ) : null}
    </label>
  )
}
