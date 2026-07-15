import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, getToken, setToken } from '../lib/api'
import { DEEP_LINK_SCHEME } from '../lib/desktopAuth'
import type { AuthResponse } from '../lib/types'
import { Login } from './Login'

// Browser-side bridge for desktop login. Opened by the native app in the system
// browser at `/desktop-auth?state=<nonce>&scheme=sharp`. If the browser already
// has a session it mints a one-time code immediately; otherwise it shows the
// normal login form, then mints. Either way it hands the code back to the native
// app via a `sharp://auth?code=&state=` deep link.

type Phase = 'checking' | 'form' | 'redirecting' | 'error'

export function DesktopAuth() {
  const [params] = useSearchParams()
  const state = params.get('state') ?? ''
  const scheme = params.get('scheme') || DEEP_LINK_SCHEME
  const [phase, setPhase] = useState<Phase>('checking')
  const [deepLink, setDeepLink] = useState('')
  const started = useRef(false)

  const mintAndRedirect = useCallback(async () => {
    const { code } = await api.desktopCode()
    const url = `${scheme}://auth?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
    setDeepLink(url)
    setPhase('redirecting')
    window.location.href = url
  }, [scheme, state])

  const onAuthenticated = useCallback(
    async (res: AuthResponse) => {
      // Persist the token so `desktopCode()` (an authed request) can mint.
      setToken(res.token)
      await mintAndRedirect()
    },
    [mintAndRedirect],
  )

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!state) {
      setPhase('error')
      return
    }
    // Already signed in on the web? Mint immediately; otherwise show the form.
    if (getToken()) {
      mintAndRedirect().catch(() => setPhase('form'))
    } else {
      setPhase('form')
    }
  }, [state, mintAndRedirect])

  if (phase === 'form') {
    return <Login onAuthenticated={onAuthenticated} />
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--color-ink)] p-6">
      <div className="w-full max-w-sm animate-in text-center">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-panel)] text-3xl font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
            #
          </div>
          <h1 className="text-2xl font-bold tracking-tight">sharp</h1>
        </div>

        {phase === 'checking' && (
          <p className="text-sm text-[var(--color-text-dim)]">Signing you in…</p>
        )}

        {phase === 'redirecting' && (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[var(--color-text-dim)]">
              Opening the sharp app… You can close this tab.
            </p>
            {deepLink && (
              <a
                href={deepLink}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)]"
              >
                Open sharp
              </a>
            )}
          </div>
        )}

        {phase === 'error' && (
          <p className="text-sm text-[var(--color-danger,#ef4444)]">
            This sign-in link is invalid or expired. Return to the app and try again.
          </p>
        )}
      </div>
    </div>
  )
}
