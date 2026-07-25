import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { registerShortcut } from '../../lib/shortcuts'
import { Button } from '../../ui'

// Panic lock: an opaque cover over the entire app, on a key or after a period
// of inactivity.
//
// Scope is deliberately honest. This hides the screen from whoever is standing
// behind you; it is *not* re-authentication. The session is untouched, so the
// unlock is a click — pretending otherwise (a password box that any local
// process could bypass by reading the same localStorage token) would suggest a
// guarantee the browser cannot make. To actually end access, sign out.

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

export function ScreenLock() {
  const idleLockMin = useStore((s) => s.ui.idleLockMin)
  const [locked, setLocked] = useState(false)

  useEffect(() => registerShortcut('privacy.lock', () => setLocked(true)), [])

  useEffect(() => {
    if (!idleLockMin || locked) return
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setLocked(true), idleLockMin * 60_000)
    }
    arm()
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, arm, { passive: true })
    return () => {
      window.clearTimeout(timer)
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, arm)
    }
  }, [idleLockMin, locked])

  if (!locked) return null

  return (
    <div
      className="fixed inset-0 z-(--z-lightbox) flex flex-col items-center justify-center gap-4 bg-ink"
      role="dialog"
      aria-modal="true"
      aria-label="Screen locked"
    >
      <div className="text-3xl font-extrabold tracking-tight text-text">sharp</div>
      <p className="max-w-xs text-center text-sm text-text-dim">
        Screen locked. Your session is still signed in — sign out if you are
        leaving this device.
      </p>
      <Button onClick={() => setLocked(false)} autoFocus>
        Unlock
      </Button>
    </div>
  )
}
