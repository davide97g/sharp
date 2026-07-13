// Desktop / OS notifications + web-push subscription.
//
// Three delivery paths, all driven from a single `notification.created` WS event:
//   - foreground toast (handled in the store)
//   - OS notification while the app is open but unfocused (this module)
//   - web push while the tab is closed (service worker + this module's subscribe)
//
// Inside the Tauri desktop shell we use the native notification plugin and skip
// web push (the OS handles background delivery).

import { api } from './api'

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let navigateFn: ((path: string) => void) | null = null
/** App registers its router navigate so notification clicks can deep-link. */
export function setNavigate(fn: (path: string) => void) {
  navigateFn = fn
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

/** Show an OS notification for a just-arrived event (app open, unfocused). */
export async function showOsNotification(
  title: string,
  body: string,
  channelId?: string,
) {
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
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, {
        body,
        tag: channelId ? `sharp-${channelId}` : undefined,
      })
      n.onclick = () => {
        window.focus()
        if (channelId && navigateFn) navigateFn(`/c/${channelId}`)
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

/** Register the service worker and subscribe this browser to web push. */
export async function initPush(): Promise<void> {
  if (isTauri) return // desktop relies on native notifications
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  try {
    const { public_key } = await api.vapidPublicKey()
    if (!public_key) return // server has web push disabled
    const reg = await navigator.serviceWorker.register('/sw.js')
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
    }
  } catch (e) {
    console.warn('web push init failed', e)
  }
}
