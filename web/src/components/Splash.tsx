import { useEffect, useRef, useState } from 'react'
import { LOGIN_BRAND_ID } from './BrandLockup'

// Brand splash shown once per page load. Logo births center-screen while a
// duck pops from a corner. When auth resolves to login, the lockup is pinned
// `position:fixed` and slides to the login brand slot; the veil fades under it.
// Already signed in → simple fade out.
//
// `ready` waits for the auth gate; `onDone` fires after exit/handoff completes.
const EXIT_MS = 300
const HANDOFF_MS = 700
const FALL_FALLBACK_MS = 3600

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

function markSplashDone() {
  document.documentElement.dataset.splashDone = ''
}

export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [landed, setLanded] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [handoff, setHandoff] = useState(false)

  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const revealedRef = useRef(false)
  const lockupRef = useRef<HTMLDivElement>(null)

  const duck = useRef(
    (() => {
      // negative anchors so the duck tucks into the corner and peeks in
      const corners = [
        { pos: { top: '-2rem', left: '-3.5rem' }, origin: 'top left', below: true },
        { pos: { top: '-2rem', right: '-3.5rem' }, origin: 'top right', below: true },
        { pos: { bottom: '-2rem', left: '-3.5rem' }, origin: 'bottom left', below: false },
        { pos: { bottom: '-2rem', right: '-3.5rem' }, origin: 'bottom right', below: false },
      ] as const
      return corners[Math.floor(Math.random() * corners.length)]
    })(),
  ).current

  const onDuckLanded = () => setLanded(true)

  useEffect(() => {
    if (!landed || !ready || revealedRef.current) return
    revealedRef.current = true

    const finish = (ms: number) => {
      const t = setTimeout(() => {
        markSplashDone()
        onDoneRef.current()
      }, ms)
      return () => clearTimeout(t)
    }

    const target = document.getElementById(LOGIN_BRAND_ID)
    const lockup = lockupRef.current
    const canHandoff =
      !!target && !!lockup && !prefersReducedMotion() && target.getClientRects().length > 0

    if (!canHandoff || !target || !lockup) {
      setExiting(true)
      return finish(EXIT_MS)
    }

    // Measure before leaving flow. Login brand stays invisible (visibility)
    // for the whole flight — no ghost tagline / double logo.
    const from = lockup.getBoundingClientRect()
    const to = target.getBoundingClientRect()

    // Pin to the exact on-screen box, then slide left/top. Same size as the
    // login brand → no scale, no end snap.
    lockup.style.position = 'fixed'
    lockup.style.left = `${from.left}px`
    lockup.style.top = `${from.top}px`
    lockup.style.margin = '0'
    lockup.style.zIndex = '2'
    lockup.style.transition = 'none'

    setHandoff(true)
    setExiting(true)

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        const ease = `left ${HANDOFF_MS}ms cubic-bezier(0.22, 1, 0.36, 1), top ${HANDOFF_MS}ms cubic-bezier(0.22, 1, 0.36, 1), color ${HANDOFF_MS}ms ease`
        lockup.style.transition = ease
        lockup.style.left = `${to.left}px`
        lockup.style.top = `${to.top}px`
        // wordmark is light-gray on ink; ease it to white over the art
        const word = lockup.querySelector('.splash-word') as HTMLElement | null
        if (word) {
          word.style.transition = `color ${HANDOFF_MS}ms ease`
          word.style.color = '#ffffff'
        }
        timer = setTimeout(() => {
          // Reveal login brand and tear down splash in the same turn — no
          // frame where both (or the tagline) are visible under a flying mark.
          markSplashDone()
          onDoneRef.current()
        }, HANDOFF_MS)
      })
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [landed, ready])

  useEffect(() => {
    const t = setTimeout(onDuckLanded, FALL_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className="splash fixed inset-0 z-[100] flex items-center justify-center"
      data-exiting={exiting ? '' : undefined}
      data-handoff={handoff ? '' : undefined}
      aria-hidden
    >
      <div className="splash-veil pointer-events-none absolute inset-0 bg-[var(--color-ink)]" />
      <div className="splash-aura pointer-events-none absolute inset-0" />

      <div
        className="splash-duck-wrap pointer-events-none absolute select-none"
        style={duck.pos as React.CSSProperties}
      >
        <img
          src="/duck.png"
          alt=""
          draggable={false}
          onAnimationEnd={onDuckLanded}
          className="splash-duck"
          style={{ transformOrigin: duck.origin } as React.CSSProperties}
        />
        <div
          className="splash-bubble-pos"
          data-side={duck.below ? 'below' : 'above'}
        >
          <span className="splash-bubble">squack</span>
        </div>
      </div>

      <div
        ref={lockupRef}
        className="splash-lockup relative flex items-center gap-3"
      >
        <div className="splash-mark relative flex h-16 w-16 shrink-0 items-center justify-center">
          <span className="splash-ring pointer-events-none absolute inset-0" aria-hidden />
          <span className="splash-glyph text-4xl font-extrabold leading-none">#</span>
        </div>
        <span className="splash-word block overflow-hidden pr-[0.12em] text-5xl font-extrabold leading-none tracking-tight text-[var(--color-text)]">
          sharp
        </span>
      </div>
    </div>
  )
}
