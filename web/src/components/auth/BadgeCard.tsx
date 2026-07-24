import { useCallback, useRef } from 'react'

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase()
}

const canTilt = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: fine)').matches &&
  !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The live member badge — a keycard that fills in as you type your name and
 * email. Full card for the desktop brand panel and the issued ceremony;
 * `compact` is the identity anchor above the mobile register steps.
 * `issued` fires the sheen sweep + check. Tilt is pointer-driven and skipped
 * on touch / reduced motion.
 */
export function BadgeCard({
  name,
  email,
  compact,
  issued,
}: {
  name: string
  email?: string
  compact?: boolean
  issued?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const tilt = useRef(canTilt())

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!tilt.current) return
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    el.style.setProperty('--ry', `${(px * 7).toFixed(2)}deg`)
    el.style.setProperty('--rx', `${(-py * 7).toFixed(2)}deg`)
  }, [])

  const onPointerLeave = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.setProperty('--rx', '0deg')
    el.style.setProperty('--ry', '0deg')
  }, [])

  const displayName = name.trim()
  const displayEmail = email?.trim()
  const initials = initialsOf(name)

  if (compact) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-3.5 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,var(--color-accent),var(--color-accent-hover))] text-sm font-extrabold text-white">
          {initials || '#'}
        </span>
        <div className="min-w-0 flex-1">
          <div
            className={`truncate text-sm font-semibold ${
              displayName ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'
            }`}
          >
            {displayName || 'Your name'}
          </div>
          <div className="truncate text-2xs text-[var(--color-text-faint)]">
            {displayEmail || 'you@sharp.chat'}
          </div>
        </div>
        <span className="text-lg font-extrabold text-[var(--color-accent)] opacity-60" aria-hidden>
          #
        </span>
      </div>
    )
  }

  return (
    <div className="relative w-full max-w-[340px]">
      {issued && (
        <span className="auth-check absolute -right-3 -top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-accent)] shadow-[0_0_20px_-2px_var(--color-accent)] ring-4 ring-[var(--color-ink)]">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path
              className="auth-check-path"
              d="M3 8.5 6.5 12 13 4.5"
              stroke="#fff"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      <div
        ref={ref}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        data-issued={issued ? 'true' : undefined}
        className="auth-badge rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-5 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.6)]"
      >
        <div className="auth-badge-sheen" aria-hidden />
        <div
          className="absolute inset-x-0 top-0 h-[3px] bg-[linear-gradient(90deg,var(--color-accent),var(--color-accent-hover))]"
          aria-hidden
        />
        <div className="flex items-center justify-between">
          <span className="flex h-7 w-7 items-center justify-center rounded-[30%] bg-[var(--color-accent)] text-sm font-extrabold text-white shadow-[0_0_16px_-4px_var(--color-accent)]">
            #
          </span>
          <span className="text-3xs font-semibold uppercase tracking-[0.18em] text-[var(--color-text-faint)]">
            sharp member
          </span>
        </div>
        <div className="mt-4 flex items-center gap-3.5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-[linear-gradient(135deg,var(--color-accent),var(--color-accent-hover))] text-xl font-extrabold text-white shadow-[0_0_24px_-6px_var(--color-accent)]">
            {initials || <span className="opacity-70">#</span>}
          </span>
          <div className="min-w-0">
            <div
              className={`truncate text-base font-bold ${
                displayName ? 'text-[var(--color-text)]' : 'text-[var(--color-text-faint)]'
              }`}
            >
              {displayName || 'Your name'}
            </div>
            <div className="truncate text-xs text-[var(--color-text-dim)]">
              {displayEmail || 'you@sharp.chat'}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-end justify-between border-t border-[var(--color-border-soft)] pt-3">
          <div>
            <div className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-faint)]">
              Member since
            </div>
            <div className="text-2xs font-semibold text-[var(--color-text-dim)]">Just now</div>
          </div>
          <div className="auth-barcode" aria-hidden />
        </div>
      </div>
    </div>
  )
}
