import { useEffect, useState } from 'react'

/** Matches the shell breakpoint used in `index.css` / AppShell (ModeRail vs bottom tabs). */
export const MOBILE_MAX_WIDTH = 800

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return matches
}

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
}

/** True when the primary pointer is coarse (touch) — for tap-to-reveal toolbars. */
export function useCoarsePointer(): boolean {
  return useMediaQuery('(hover: none), (pointer: coarse)')
}
