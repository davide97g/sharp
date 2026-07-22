// Native macOS (Tauri) APNs remote push — closed-app notifications.
//
// This only produces a token in a Developer-ID **signed + notarized** build whose
// App ID has the Push Notifications capability (see Entitlements.plist). In any
// other build (unsigned/ad-hoc dev) registration rejects, and we silently fall
// back to the existing paths: the WebSocket + local `tauri-plugin-notifications`
// banner while the app is open, and web push for the PWA. Registration must never
// throw into app startup.

import { api } from './api'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let currentToken: string | null = null

/**
 * Best-effort: request permission, register with APNs, and hand the device token
 * to the server. No-op outside the Tauri desktop shell; swallows all failures
 * (unsigned build, missing entitlement, user denial) so callers can fire-and-forget.
 */
export async function registerApnsIfDesktop(): Promise<void> {
  if (!isTauri || currentToken) return
  try {
    const m = await import('@choochmeque/tauri-plugin-notifications-api')
    let granted = await m.isPermissionGranted()
    if (!granted) granted = (await m.requestPermission()) === 'granted'
    if (!granted) return
    // Resolves to the hex APNs device token on macOS; rejects on an unsigned or
    // unentitled build — which is exactly when we want to fall back silently.
    const token = await m.registerForPushNotifications()
    if (typeof token === 'string' && token) {
      await api.registerApns(token)
      currentToken = token
    }
  } catch (e) {
    console.warn('apns registration skipped (falling back to local/web push)', e)
  }
}

/** Best-effort unregister on logout so the device stops receiving this user's push. */
export async function unregisterApnsIfDesktop(): Promise<void> {
  if (!isTauri || !currentToken) return
  const token = currentToken
  currentToken = null
  try {
    await api.unregisterApns(token)
    const m = await import('@choochmeque/tauri-plugin-notifications-api')
    await m.unregisterForPushNotifications()
  } catch (e) {
    console.warn('apns unregister failed', e)
  }
}
