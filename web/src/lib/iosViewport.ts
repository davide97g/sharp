/**
 * iOS home-screen (standalone) PWA viewport workarounds.
 *
 * 1. Launch-size bug: WebKit occasionally boots a standalone web app with a
 *    stale, too-small layout viewport — the whole UI renders in a shrunken
 *    box until the device is rotated. Re-asserting the viewport meta forces
 *    WebKit to recompute the layout viewport.
 * 2. Keyboard pan bug: dismissing the on-screen keyboard can leave the
 *    layout viewport panned upward, so fixed chrome (bottom tab bar,
 *    composer) sits partly offscreen. Scrolling back to the origin restores
 *    alignment.
 */
export function installIosViewportFix() {
  const ua = navigator.userAgent
  const isIos =
    /iP(hone|ad|od)/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (!isIos || !standalone) return

  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
  let lastAttempt = ''

  const viewportLooksStale = () => {
    // On iPhone the standalone viewport spans the full screen; iPad
    // multitasking never applies (Split View apps aren't standalone PWAs).
    const short = Math.min(screen.width, screen.height)
    const long = Math.max(screen.width, screen.height)
    const portrait = window.matchMedia('(orientation: portrait)').matches
    const expected = portrait ? short : long
    return Math.abs(window.innerWidth - expected) > 2
  }

  const heal = () => {
    if (!meta || !viewportLooksStale()) return
    const key = `${window.innerWidth}x${window.innerHeight}`
    if (key === lastAttempt) return
    lastAttempt = key
    const content = meta.getAttribute('content') ?? ''
    // Actually changing the attribute is what makes WebKit re-run viewport
    // resolution; restoring it the next frame leaves the page zoomable.
    meta.setAttribute('content', `${content}, minimum-scale=1`)
    requestAnimationFrame(() => meta.setAttribute('content', content))
  }

  // The launch bug shows up in the first moments after boot.
  for (const delay of [250, 1000, 3000]) window.setTimeout(heal, delay)
  window.addEventListener('pageshow', heal)
  window.addEventListener('orientationchange', () => window.setTimeout(heal, 250))
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) window.setTimeout(heal, 250)
  })

  // After the keyboard goes away, snap the layout viewport back to origin so
  // fixed chrome realigns with the visual viewport.
  const editable = 'input, textarea, select, [contenteditable="true"]'
  const keyboardGone = () =>
    !(document.activeElement instanceof HTMLElement && document.activeElement.matches(editable))
  document.addEventListener('focusout', (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(editable)) return
    window.setTimeout(() => {
      if (keyboardGone()) window.scrollTo(0, 0)
    }, 60)
  })
  window.visualViewport?.addEventListener('resize', () => {
    if (keyboardGone() && (window.scrollY !== 0 || (window.visualViewport?.offsetTop ?? 0) > 0)) {
      window.scrollTo(0, 0)
    }
  })
}
