// First-login onboarding: a skippable full-screen stepper shown once per client.
// Completion is a client-only flag (there is no server-side onboarding state),
// mirroring the localStorage convention used for other purely-client prefs.
// Theme presets live in lib/theme.ts.

const DONE_KEY = 'sharp.onboarding.v1'

export function isOnboardingDone(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === 'done'
  } catch {
    return true // if storage is unavailable, don't nag
  }
}

export function markOnboardingDone() {
  try {
    window.localStorage.setItem(DONE_KEY, 'done')
  } catch {
    /* ignore */
  }
}
