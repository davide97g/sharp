import { useId, useState, type CSSProperties } from 'react'
import { EyeIcon, EyeOffIcon } from '../../ui'

/**
 * The auth-stage input: visible label, optional hint, inline error announced
 * via role="alert", and a show/hide toggle on password fields. Reuses the
 * `.login-field*` chrome so focus/hover motion matches the rest of the app.
 * Pass `index` to join the step's staggered rise (45ms cadence via --i).
 *
 * TODO(ds): not migrated to Field+Input — the `.login-field*` scoped CSS carries
 * behavior the primitives don't (focus-within label color, `data-invalid` hooks,
 * per-field stagger, the password reveal button). Only the eye glyphs and micro
 * text sizes were swapped to DS. Revisit once Field/Input expose those hooks.
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
            {revealed ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
          </button>
        )}
      </span>
      {error ? (
        <span id={errorId} role="alert" className="auth-field-error text-xs">
          {error}
        </span>
      ) : hint ? (
        <span className="text-2xs text-[var(--color-text-faint)]">{hint}</span>
      ) : null}
    </label>
  )
}
