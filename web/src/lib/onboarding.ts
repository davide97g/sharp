// First-login onboarding: a skippable full-screen stepper shown once per client.
// Completion is a client-only flag (there is no server-side onboarding state),
// mirroring the localStorage convention used for other purely-client prefs.

const DONE_KEY = 'sharp.onboarding.v1'
const THEME_KEY = 'sharp.theme'

export type ThemeChoice = 'dark' | 'light'

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

// Theme is a setup-time choice only in v1 — persisted here, applied later once
// light-mode CSS variables land. Default is dark (the app's only current theme).
export function getThemeChoice(): ThemeChoice {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export function setThemeChoice(theme: ThemeChoice) {
  try {
    window.localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* ignore */
  }
}
