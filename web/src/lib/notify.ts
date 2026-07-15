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
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
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

// A cute little two-note chime, synthesized on the fly (no asset to ship).
// A soft triangle "ding-dong" (E6 → B6) with a quick bell-like decay.
let audioCtx: AudioContext | null = null
type SynthNote = { freq: number; at: number }

function playSynthNotes(
  notes: SynthNote[],
  { volume, decay, wave = 'triangle' }: {
    volume: number
    decay: number
    wave?: OscillatorType
  },
) {
  if (typeof window === 'undefined') return
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return
    if (!audioCtx) audioCtx = new Ctor()
    const ctx = audioCtx
    // A gesture may be needed to unlock; resume() is a no-op if already running.
    void ctx.resume()
    const t0 = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = volume
    master.connect(ctx.destination)
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      osc.type = wave
      osc.frequency.value = n.freq
      const start = t0 + n.at
      g.gain.setValueAtTime(0.0001, start)
      g.gain.exponentialRampToValueAtTime(1, start + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, start + decay)
      osc.connect(g)
      g.connect(master)
      osc.start(start)
      osc.stop(start + decay + 0.03)
    }
  } catch {
    /* audio not available — ignore */
  }
}

export function playNotifySound() {
  playSynthNotes(
    [
      { freq: 1318.5, at: 0 }, // E6
      { freq: 1975.5, at: 0.11 }, // B6
    ],
    { volume: 0.14, decay: 0.42 },
  )
}

/** A short, warm ascending cue for joining a room or greeting a participant. */
export function playVoiceJoinSound() {
  playSynthNotes(
    [
      { freq: 523.25, at: 0 }, // C5
      { freq: 659.25, at: 0.1 }, // E5
    ],
    { volume: 0.1, decay: 0.24, wave: 'sine' },
  )
}

/** The matching descending cue for leaving a room or a participant departing. */
export function playVoiceLeaveSound() {
  playSynthNotes(
    [
      { freq: 659.25, at: 0 }, // E5
      { freq: 523.25, at: 0.1 }, // C5
    ],
    { volume: 0.09, decay: 0.22, wave: 'sine' },
  )
}

/** A gentle two-tone huddle invitation, repeated twice. */
export function playHuddleRingSound() {
  playSynthNotes(
    [
      { freq: 659.25, at: 0 }, // E5
      { freq: 783.99, at: 0.14 }, // G5
      { freq: 659.25, at: 0.48 },
      { freq: 783.99, at: 0.62 },
    ],
    { volume: 0.1, decay: 0.28 },
  )
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
