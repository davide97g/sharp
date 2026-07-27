import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useStore } from '../store'
import { sound } from '../lib/sound'
import { SESSION_KEYS, writeSession } from '../lib/localPrefs'
import { BrandLockup } from './BrandLockup'

/**
 * Landing page for a completed social sign-in (`/oauth?code=…`). Public route.
 *
 * The server's OAuth callback never puts a session token in a URL — it redirects
 * here with a single-use, 60-second handoff code, which this page trades for the
 * real JWT. Failures land on /login with an `oauth_error` instead of here.
 *
 * Contract: docs/arch/01-core.md, "Social sign-in".
 */
export function OauthCallback() {
  const [params] = useSearchParams()
  const code = params.get('code') ?? ''
  const navigate = useNavigate()
  const init = useStore((s) => s.init)
  const [error, setError] = useState<string | null>(null)
  // React 18 mounts effects twice in dev StrictMode; the code is single-use, so a
  // second exchange would fail against a code the first attempt already spent.
  const claimed = useRef(false)

  useEffect(() => {
    if (claimed.current) return
    claimed.current = true

    if (!code) {
      navigate('/login', { replace: true })
      return
    }

    let cancelled = false
    void (async () => {
      try {
        const res = await api.oauthExchange(code)
        if (cancelled) return
        await init(res.token, res.user)
        writeSession(SESSION_KEYS.offerPasskey, '1')
        sound.loginSuccess()
        navigate('/', { replace: true })
      } catch (err) {
        if (cancelled) return
        setError(
          err instanceof Error
            ? err.message
            : 'This sign-in link expired. Please try again.',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [code, init, navigate])

  return (
    <div className="login-screen flex h-full min-h-0 w-full items-center justify-center overflow-y-auto bg-[var(--color-ink)] px-6 py-10">
      <div className="auth-ambient" aria-hidden>
        <div className="auth-aurora auth-aurora-a" />
        <div className="auth-aurora auth-aurora-b" />
        <div className="auth-hashmark">#</div>
      </div>

      <div className="relative w-full max-w-sm text-center">
        <div className="mb-8 flex justify-center">
          <BrandLockup wordClassName="text-[var(--color-text)]" />
        </div>

        {error ? (
          <div className="auth-swap">
            <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
              Sign-in didn’t complete.
            </h1>
            <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">{error}</p>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="login-primary-action mt-6 min-h-11 w-full cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-base font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] sm:text-sm"
            >
              Back to sign in
            </button>
          </div>
        ) : (
          <div className="auth-swap">
            <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
              Signing you in…
            </h1>
            <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
              One moment while we set up your workspace.
            </p>
            <div className="auth-progress mx-auto mt-6" aria-hidden />
          </div>
        )}
      </div>
    </div>
  )
}
