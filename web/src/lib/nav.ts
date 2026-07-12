import type { NavigateFunction } from 'react-router-dom'

// Module-level navigate handle so non-React contexts (e.g. BlockNote inline
// content render components, which live outside the router's hook tree) can
// route without prop-drilling. Set once from a component that has useNavigate.
let navigateFn: NavigateFunction | null = null

export function setNavigate(fn: NavigateFunction) {
  navigateFn = fn
}

export function navigateTo(to: string) {
  if (navigateFn) navigateFn(to)
  else window.location.assign(to)
}
