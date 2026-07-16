/** Stable id the splash uses to FLIP the loading mark onto the login brand. */
export const LOGIN_BRAND_ID = 'login-brand-lockup'

/**
 * Official sharp mark + wordmark. Sized to match the splash lockup's resting
 * state exactly so the handoff is a pure translate (no scale mismatch / snap).
 */
export function BrandLockup({
  id,
  className = '',
  markClassName = '',
  wordClassName = '',
}: {
  id?: string
  className?: string
  markClassName?: string
  wordClassName?: string
}) {
  return (
    <div id={id} className={`brand-lockup flex items-center gap-3 ${className}`}>
      <div
        className={`brand-mark relative flex h-16 w-16 shrink-0 items-center justify-center rounded-[30%] bg-[var(--color-accent)] shadow-[0_0_44px_-4px_var(--color-accent)] ${markClassName}`}
      >
        <span className="brand-glyph text-4xl font-extrabold leading-none text-white" aria-hidden>
          #
        </span>
      </div>
      <span
        className={`brand-word block pr-[0.12em] text-5xl font-extrabold leading-none tracking-tight text-[var(--color-text)] ${wordClassName}`}
      >
        sharp
      </span>
    </div>
  )
}
