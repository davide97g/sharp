import { useEffect, useRef, useState } from 'react'
import { LOGIN_BRAND_ID } from './BrandLockup'

// Brand splash shown once per page load. From the very start a glowing rubber
// duck pops from a corner while the logo reveals: a point of light grows into
// a white ring, the `#` fades in, the disc fills and morphs into the rounded
// purple tile, then the "sharp" wordmark types out.
//
// When auth resolves to the login screen, the lockup FLIPs from center-screen
// into the login brand's exact top-left + size, while the splash veil fades.
// When already signed in, the whole layer just eases out.
//
// `ready` is the auth gate's resolution signal; the reveal waits for both the
// duck beat AND auth to resolve, so it never flashes the wrong screen.
// `onDone` fires after the exit (or handoff) completes.
const EXIT_MS = 300
const HANDOFF_MS = 720
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
  // Keep transform in React state so a re-render can't wipe a DOM-only style
  // and snap the lockup back to center mid-flight / at the end.
  const [handoffTransform, setHandoffTransform] = useState<string | null>(null)

  // call the latest onDone without making it an effect dependency — otherwise a
  // re-render (onDone is a fresh closure each time) re-runs an effect whose
  // cleanup clears the pending unmount timer, and the splash gets stuck.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const revealedRef = useRef(false)
  const lockupRef = useRef<HTMLDivElement>(null)

  // pick a random corner for the duck to pop out of. It bounces in, says
  // "squack" in a little bubble, then bounces back out — origin is the screen
  // corner so it grows out of it, and the bubble sits on the screen-inward side.
  const duck = useRef(
    (() => {
      // negative anchors so the duck tucks into the very corner and peeks in
      // (its far edge clipped by the viewport), rather than sitting inset.
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

  // reveal once the duck beat is done AND auth is resolved; runs exactly once
  useEffect(() => {
    if (!landed || !ready || revealedRef.current) return
    revealedRef.current = true

    const finish = (ms: number) => {
      markSplashDone()
      const t = setTimeout(() => onDoneRef.current(), ms)
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

    // FLIP with transform-origin at the lockup's top-left. Login brand is a
    // uniform scale of this splash lockup, so width-based scale lands the whole
    // box (mark + word) on the target with no end snap.
    const from = lockup.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const dx = to.left - from.left
    const dy = to.top - from.top
    const scale = to.width / from.width

    setHandoff(true)
    setExiting(true)

    // double-rAF: commit transition styles, then set the destination transform
    // so the browser interpolates from identity → handoff.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return
        setHandoffTransform(`translate(${dx}px, ${dy}px) scale(${scale})`)
        timer = setTimeout(() => {
          // Reveal the real brand first (now under the flying lockup), then
          // unmount the splash — boxes match so the swap is invisible.
          markSplashDone()
          requestAnimationFrame(() => onDoneRef.current())
        }, HANDOFF_MS)
      })
    })

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [landed, ready])

  // fallback marks the duck beat done even when its animationend never fires
  // — e.g. under prefers-reduced-motion.
  useEffect(() => {
    const t = setTimeout(onDuckLanded, FALL_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className="splash fixed inset-0 z-[100] flex items-center justify-center overflow-hidden"
      data-exiting={exiting ? '' : undefined}
      data-handoff={handoff ? '' : undefined}
      aria-hidden
    >
      {/* solid ink + aura — fade independently so the lockup can keep flying */}
      <div className="splash-veil pointer-events-none absolute inset-0 bg-[var(--color-ink)]" />
      <div className="splash-aura pointer-events-none absolute inset-0" />

      {/* the rubber duck pops out of a random corner with a little bounce,
          says "squack" in a bubble, then bounces back out — the pop's end
          dismisses the splash */}
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

      {/* logo lockup: the mark births from a dot → ring → tile, then the
          wordmark reveals out to its right. On handoff this node FLIPs into
          #login-brand-lockup's box. */}
      <div
        ref={lockupRef}
        className="splash-lockup relative flex items-center gap-3"
        style={
          handoff
            ? {
                transition: `transform ${HANDOFF_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                transformOrigin: '0 0',
                transform: handoffTransform ?? 'translate(0px, 0px) scale(1)',
                willChange: 'transform',
                zIndex: 2,
              }
            : undefined
        }
      >
        <div className="splash-mark relative flex h-16 w-16 shrink-0 items-center justify-center">
          <span className="splash-ring pointer-events-none absolute inset-0" aria-hidden />
          <span className="splash-glyph text-4xl font-extrabold leading-none">#</span>
        </div>
        <span className="splash-word block overflow-hidden pr-[0.12em] text-5xl font-extrabold tracking-tight text-[var(--color-text)]">
          sharp
        </span>
      </div>
    </div>
  )
}
