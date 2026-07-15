// Desktop browser-login: open the system browser to authenticate on the web
// app, then receive a one-time code back via a `sharp://auth?...` deep link and
// exchange it for a JWT. Native (Tauri) only — no-ops / not wired on the web.

import { api, resolveBaseUrl } from './api'
import type { AuthResponse } from './types'

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Custom URL scheme registered by the Tauri shell (tauri.conf.json). */
export const DEEP_LINK_SCHEME = 'sharp'

const STATE_KEY = 'sharp.desktopAuthState'

function randomState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Kick off browser login from the native app: persist a CSRF nonce, then open
 * the system browser at the workspace's `/desktop-auth` bridge page. The server
 * URL must already be resolvable (caller persists it first via `setServerUrl`).
 */
export async function startBrowserLogin(): Promise<void> {
  const state = randomState()
  localStorage.setItem(STATE_KEY, state)
  const base = resolveBaseUrl()
  const url = `${base}/desktop-auth?state=${encodeURIComponent(state)}&scheme=${DEEP_LINK_SCHEME}`
  const { open } = await import('@tauri-apps/plugin-shell')
  await open(url)
}

/**
 * Parse a `sharp://auth?code=&state=` deep link, verify the state nonce, and
 * exchange the code for a JWT. Returns null if the URL isn't an auth callback
 * or the state doesn't match (rejected). Throws on a failed exchange.
 */
export async function handleAuthDeepLink(rawUrl: string): Promise<AuthResponse | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  // sharp://auth?...  -> protocol "sharp:", host "auth"
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.host !== 'auth') return null

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expected = localStorage.getItem(STATE_KEY)
  if (!code || !state || !expected || state !== expected) return null
  localStorage.removeItem(STATE_KEY)

  return api.desktopExchange(code)
}

/**
 * Register the native deep-link listener (running instance) and drain any URL
 * that cold-launched the app. `onAuth` is invoked with the exchanged response.
 * Returns a cleanup function. Native only.
 */
export async function registerDeepLinkHandler(
  onAuth: (res: AuthResponse) => void | Promise<void>,
  onError?: (err: unknown) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const deepLink = await import('@tauri-apps/plugin-deep-link')

  const process = async (urls: string[] | null) => {
    if (!urls) return
    for (const u of urls) {
      try {
        const res = await handleAuthDeepLink(u)
        if (res) await onAuth(res)
      } catch (err) {
        onError?.(err)
      }
    }
  }

  const unlisten = await deepLink.onOpenUrl((urls) => void process(urls))
  // Cold launch: the URL that started the app (if any).
  try {
    const current = await deepLink.getCurrent()
    await process(current ?? null)
  } catch {
    /* getCurrent unsupported on this platform — ignore */
  }
  return unlisten
}
