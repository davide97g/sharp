// Celebration bursts for the handful of moments worth marking: a task reaching
// a completed state, a poll closing, someone joining a call.
//
// Deliberately dependency-free and DOM-based (a dozen absolutely-positioned
// spans driven by WAAPI) rather than a canvas library — the whole effect is
// under a kilobyte and disappears completely when it should.
//
// Four independent ways to get nothing, all checked at fire time:
//   - `prefers-reduced-motion`
//   - the motion slider at 0
//   - Focus mode (or the streaming privacy shield, which implies it)
//   - the celebrations preference itself
// The caller supplies the last three via `configureCelebrations`; this module
// owns only the motion query so it stays usable from anywhere.

type CelebrationConfig = { enabled: boolean; motion: number }

let config: CelebrationConfig = { enabled: true, motion: 1 }

export function configureCelebrations(next: CelebrationConfig) {
  config = next
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function allowed(): boolean {
  if (typeof document === 'undefined') return false
  if (!config.enabled || config.motion === 0) return false
  return !reducedMotion()
}

const COLORS = [
  'var(--color-accent)',
  'var(--color-accent-hover)',
  'var(--color-success-fg)',
  'var(--color-warning-fg)',
  'var(--color-text)',
]

/**
 * Confetti from a point (viewport coordinates). Defaults to just above centre,
 * which reads as "from the content" for events with no on-screen anchor.
 */
export function confettiAt(x?: number, y?: number, count = 26) {
  if (!allowed()) return
  const originX = x ?? window.innerWidth / 2
  const originY = y ?? window.innerHeight * 0.38
  const layer = document.createElement('div')
  layer.className = 'celebrate-layer'
  layer.setAttribute('aria-hidden', 'true')
  document.body.appendChild(layer)

  const duration = 1100 / Math.max(0.25, config.motion)
  let longest = 0
  for (let i = 0; i < count; i++) {
    const bit = document.createElement('i')
    const size = 5 + Math.round(Math.random() * 5)
    bit.style.cssText = `left:${originX}px;top:${originY}px;width:${size}px;height:${size * (Math.random() < 0.4 ? 2 : 1)}px;background:${COLORS[i % COLORS.length]}`
    layer.appendChild(bit)

    // Upward cone, then gravity — a straight radial spray reads as a firework,
    // not confetti.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9
    const speed = 120 + Math.random() * 220
    const dx = Math.cos(angle) * speed
    const dy = Math.sin(angle) * speed
    const life = duration * (0.7 + Math.random() * 0.5)
    longest = Math.max(longest, life)
    bit.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(${dx * 0.6}px, ${dy * 0.75}px) rotate(${Math.random() * 220 - 110}deg)`,
          opacity: 1,
          offset: 0.45,
        },
        {
          transform: `translate(${dx}px, ${dy + 260}px) rotate(${Math.random() * 540 - 270}deg)`,
          opacity: 0,
        },
      ],
      { duration: life, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
    )
  }
  window.setTimeout(() => layer.remove(), longest + 120)
}

/** Confetti anchored to an element — used when the triggering row is on screen. */
export function confettiFrom(el: Element | null | undefined, count?: number) {
  if (!allowed()) return
  if (!el) return confettiAt(undefined, undefined, count)
  const r = el.getBoundingClientRect()
  confettiAt(r.left + r.width / 2, r.top + r.height / 2, count)
}
