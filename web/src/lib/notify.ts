// Desktop / OS notifications + web-push subscription.
//
// Three delivery paths, all driven from a single `notification.created` WS event:
//   - foreground toast (handled in the store)
//   - OS notification while the app is open but unfocused (this module)
//   - web push while the tab is closed (service worker + this module's subscribe)
//
// Inside the Tauri desktop shell we use the native notification plugin and skip
// web push (the OS handles background delivery).

import { api, apiBase } from './api'

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export type NotificationSetupState =
  | 'unsupported'
  | 'install-required'
  | 'prompt'
  | 'subscribed'
  | 'denied'
  | 'error'

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches
}

/** Synchronous capability state for initial render; subscription state is refined asynchronously. */
export function initialNotificationState(): NotificationSetupState {
  if (isTauri) return 'prompt'
  if (isIos() && !isStandalonePwa()) return 'install-required'
  if (
    typeof Notification === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission === 'granted') return 'prompt'
  return 'prompt'
}

/** Current browser permission + push subscription state. Never prompts. */
export async function getNotificationState(): Promise<NotificationSetupState> {
  const initial = initialNotificationState()
  if (isTauri || initial === 'install-required' || initial === 'unsupported' || initial === 'denied') {
    return initial
  }
  if (Notification.permission !== 'granted') return 'prompt'
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    return sub ? 'subscribed' : 'prompt'
  } catch {
    return 'error'
  }
}

let navigateFn: ((path: string) => void) | null = null
/** App registers its router navigate so notification clicks can deep-link. */
export function setNavigate(fn: (path: string) => void) {
  navigateFn = fn
}
/** Deep-link into a channel (used by toast / OS-notification clicks). */
export function navigateToChannel(channelId: string) {
  if (navigateFn) navigateFn(`/c/${channelId}`)
}

export function isWebNotifyGranted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

/** Request OS notification permission (Tauri plugin or Web Notification API). */
export async function requestNotifyPermission(): Promise<boolean> {
  if (isTauri) {
    try {
      const m = await import('@tauri-apps/plugin-notification')
      let granted = await m.isPermissionGranted()
      if (!granted) granted = (await m.requestPermission()) === 'granted'
      return granted
    } catch {
      /* fall through to web */
    }
  }
  if (typeof Notification === 'undefined') return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  try {
    return (await Notification.requestPermission()) === 'granted'
  } catch {
    return false
  }
}

/**
 * Show an OS notification for a just-arrived event (app open, unfocused).
 * `deepLink` is the in-app path a click should navigate to; `tag` collapses
 * repeat notifications for the same target.
 */
export async function showOsNotification(
  title: string,
  body: string,
  opts?: { deepLink?: string; tag?: string },
) {
  const deepLink = opts?.deepLink
  const tag = opts?.tag
  if (isTauri) {
    try {
      const m = await import('@tauri-apps/plugin-notification')
      if (await m.isPermissionGranted()) {
        m.sendNotification({ title, body })
        return
      }
    } catch {
      /* fall through */
    }
  }
  // Hidden browser/PWA pages receive the service-worker push. Page-created
  // notifications here would duplicate it. Keep this path for a visible but
  // unfocused desktop tab; Tauri already returned above.
  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted' &&
    document.visibilityState === 'visible'
  ) {
    try {
      const n = new Notification(title, { body, tag })
      n.onclick = () => {
        window.focus()
        if (deepLink && navigateFn) navigateFn(deepLink)
        n.close()
      }
    } catch {
      /* ignore */
    }
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

/** Register the service worker (PWA installability + push). Safe to call often. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (isTauri) return Promise.resolve(null)
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  // Skip in Vite dev — a caching SW breaks HMR; push still works on prod builds.
  if (import.meta.env.DEV) return Promise.resolve(null)
  if (!swRegistration) {
    swRegistration = navigator.serviceWorker
      // updateViaCache 'none': update checks always refetch sw.js from the
      // server, so a deploy is noticed on the first check after it lands.
      .register('/sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        watchForAppUpdates(reg)
        return reg
      })
      .catch((e) => {
        console.warn('service worker registration failed', e)
        swRegistration = null
        return null
      })
  }
  return swRegistration
}

let swRegistration: Promise<ServiceWorkerRegistration | null> | null = null

/**
 * Keep long-lived sessions (installed PWAs especially) on the latest deploy.
 * sw.js carries a per-build id and skipWaiting()s, so: check → new worker
 * installs → takes control → we reload once onto the new version. The reload
 * is deferred while the user is mid-typing so a deploy never eats a draft.
 */
function watchForAppUpdates(reg: ServiceWorkerRegistration) {
  let lastCheck = Date.now()
  const check = () => {
    if (Date.now() - lastCheck < 60_000) return
    lastCheck = Date.now()
    reg.update().catch(() => {})
  }
  window.setInterval(check, 15 * 60_000)
  window.addEventListener('focus', check)
  window.addEventListener('online', check)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check()
  })

  let hadController = !!navigator.serviceWorker.controller
  let reloading = false
  const reload = () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First-ever install claiming the page is not an update — don't reload.
    if (!hadController) {
      hadController = true
      return
    }
    const active = document.activeElement
    const typing =
      active instanceof HTMLElement &&
      active.matches('input, textarea, [contenteditable="true"]')
    if (!typing) return reload()
    active.addEventListener('blur', reload, { once: true })
    document.addEventListener('visibilitychange', reload, { once: true })
  })
}

/** Register the service worker and subscribe this browser to web push. */
export async function initPush(): Promise<NotificationSetupState> {
  if (isTauri) return 'subscribed' // desktop relies on native notifications
  const initial = initialNotificationState()
  if (initial === 'install-required' || initial === 'unsupported' || initial === 'denied') {
    return initial
  }
  if (Notification.permission !== 'granted') return 'prompt'
  try {
    const { public_key } = await api.vapidPublicKey()
    if (!public_key) return 'unsupported' // server has web push disabled
    const reg = await registerServiceWorker()
    if (!reg) return 'error'
    await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(public_key) as BufferSource,
      })
    }
    const json = sub.toJSON() as {
      endpoint?: string
      keys?: { p256dh?: string; auth?: string }
    }
    if (json.endpoint && json.keys?.p256dh && json.keys?.auth) {
      await api.subscribePush({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      })
      return 'subscribed'
    }
    return 'error'
  } catch (e) {
    console.warn('web push init failed', e)
    return 'error'
  }
}

/** User-initiated notification setup. Permission request stays inside click task. */
export async function enableNotifications(): Promise<NotificationSetupState> {
  const initial = initialNotificationState()
  if (initial === 'install-required' || initial === 'unsupported' || initial === 'denied') {
    return initial
  }
  const granted = await requestNotifyPermission()
  if (!granted) {
    return typeof Notification !== 'undefined' && Notification.permission === 'denied'
      ? 'denied'
      : 'prompt'
  }
  return initPush()
}

/**
 * Remove local subscription and its server mapping. `tokenOverride` lets logout
 * clear local auth immediately without racing the authenticated cleanup fetch.
 */
export async function disablePush(tokenOverride?: string | null): Promise<NotificationSetupState> {
  if (isTauri || !('serviceWorker' in navigator)) return initialNotificationState()
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      if (tokenOverride !== undefined) {
        if (tokenOverride) {
          await fetch(`${apiBase()}/push/unsubscribe`, {
            method: 'POST',
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${tokenOverride}`,
            },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          })
        }
      } else {
        await api.unsubscribePush(sub.endpoint)
      }
      await sub.unsubscribe()
    }
  } catch (e) {
    console.warn('web push unsubscribe failed', e)
    return 'error'
  }
  return initialNotificationState()
}
