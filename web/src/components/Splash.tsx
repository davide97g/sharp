import { useEffect, useRef, useState } from 'react'

// Brand splash shown once per page load. From the very start a glowing rubber
// duck tumbles slowly down from the top — random spot, random spin — while the
// logo reveals underneath it: a point of light grows into a white ring, the `#`
// fades in, the disc fills and morphs into the rounded purple tile, then the
// "sharp" wordmark types out. The duck's slow fall IS the timeline; as it
// passes the bottom the splash wipes out to reveal the app if signed in, or the
// login screen if not.
//
// `ready` is the auth gate's resolution signal; the reveal waits for both the
// duck to pass AND auth to resolve, so it never flashes the wrong screen.
// `onDone` fires after the exit completes.
const EXIT_MS = 300
const FALL_FALLBACK_MS = 3600

export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [landed, setLanded] = useState(false)
  const [exiting, setExiting] = useState(false)

  // call the latest onDone without making it an effect dependency — otherwise a
  // re-render (onDone is a fresh closure each time) re-runs an effect whose
  // cleanup clears the pending unmount timer, and the splash gets stuck.
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const revealedRef = useRef(false)

  // randomize the duck's fall each time: horizontal spot, spin amount +
  // direction, sideways drift, and a slow speed that spans the logo reveal.
  const fall = useRef({
    x: 20 + Math.random() * 60, // left %
    rot: (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 480), // deg
    drift: (Math.random() * 2 - 1) * 120, // px
    dur: 2.7 + Math.random() * 0.7, // s — slow, covers the whole logo animation
  }).current

  const onDuckLanded = () => setLanded(true)

  // reveal once the duck has passed AND auth is resolved; runs exactly once
  useEffect(() => {
    if (!landed || !ready || revealedRef.current) return
    revealedRef.current = true
    setExiting(true)
    const t = setTimeout(() => onDoneRef.current(), EXIT_MS)
    return () => clearTimeout(t)
  }, [landed, ready])

  // fallback marks the duck landed even when the fall animation (and its
  // animationend event) never runs — e.g. under prefers-reduced-motion.
  useEffect(() => {
    const t = setTimeout(onDuckLanded, FALL_FALLBACK_MS)
    return () => clearTimeout(t)
  }, [])

  return (
    <div
      className="splash fixed inset-0 z-[100] flex items-center justify-center overflow-hidden bg-[var(--color-ink)]"
      data-exiting={exiting ? '' : undefined}
      aria-hidden
    >
      {/* soft accent glow behind everything */}
      <div className="splash-aura pointer-events-none absolute inset-0" />

      {/* the tumbling rubber duck — falls slowly from the top from the start;
          when it passes the bottom it dismisses the splash */}
      <img
        src="/duck.png"
        alt=""
        draggable={false}
        onAnimationEnd={onDuckLanded}
        className="splash-duck pointer-events-none absolute select-none"
        style={
          {
            left: `${fall.x}%`,
            '--duck-rot': `${fall.rot}deg`,
            '--duck-drift': `${fall.drift}px`,
            '--duck-dur': `${fall.dur}s`,
          } as React.CSSProperties
        }
      />

      {/* logo lockup: the mark births from a dot → ring → tile, then the
          wordmark reveals out to its right */}
      <div className="splash-lockup relative flex items-center gap-3">
        <div className="splash-mark relative flex h-16 w-16 items-center justify-center">
          <span className="splash-ring pointer-events-none absolute inset-0" aria-hidden />
          <span className="splash-glyph text-4xl font-extrabold leading-none">#</span>
        </div>
        <div className="splash-word overflow-hidden">
          <span className="block text-5xl font-extrabold tracking-tight text-[var(--color-text)]">
            sharp
          </span>
        </div>
      </div>
    </div>
  )
}
