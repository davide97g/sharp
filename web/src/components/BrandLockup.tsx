/** Stable id the splash uses to FLIP the loading mark onto the login brand. */
export const LOGIN_BRAND_ID = 'login-brand-lockup'

/**
 * Login brand mark — kept as a uniform scale of the splash lockup (64→48)
 * so the FLIP handoff can land on an identical layout and not snap at the end.
 * Splash: mark 64 / glyph 36 / word 48 / gap 12
 * Login:  mark 48 / glyph 27 / word 36 / gap 9  (= ×0.75)
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
    <div
      id={id}
      className={`flex items-center gap-[9px] ${className}`}
    >
      <div
        className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-[30%] bg-[var(--color-accent)] shadow-[0_0_33px_-3px_var(--color-accent)] ${markClassName}`}
      >
        <span
          className="text-[1.6875rem] font-extrabold leading-none text-white"
          aria-hidden
        >
          #
        </span>
      </div>
      <span
        className={`block pr-[0.12em] text-4xl font-extrabold tracking-tight text-[var(--color-text)] ${wordClassName}`}
      >
        sharp
      </span>
    </div>
  )
}
