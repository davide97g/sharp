// First-login onboarding: a skippable full-screen stepper shown once per client.
// Completion is a client-only flag (there is no server-side onboarding state),
// mirroring the localStorage convention used for other purely-client prefs.
// Theme presets live in lib/theme.ts.

import { KEYS, readLocal, writeLocal } from './localPrefs'

export function isOnboardingDone(): boolean {
  // Unreadable storage counts as done — better to skip the tour than to loop it.
  return readLocal(KEYS.onboarding) === 'done'
}

export function markOnboardingDone() {
  writeLocal(KEYS.onboarding, 'done')
}
