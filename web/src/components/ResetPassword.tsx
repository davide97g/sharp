import { useState, type CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, ApiRequestError } from '../lib/api'
import { toastError } from '../lib/toast'
import { sound } from '../lib/sound'
import { BrandLockup } from './BrandLockup'
import { AuthField } from './auth/AuthField'
import { SharpnessMeter } from './auth/SharpnessMeter'

const canAutofocus = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: fine)').matches ?? false)

/**
 * Landing page for the emailed reset link (`/reset-password?token=…`). Public
 * route — reachable whether or not anyone is signed in. Sets a new password
 * against the one-time token, then bounces to /login.
 */
export function ResetPassword() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setError(null)
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords don’t match.')
      return
    }
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      sound.loginSuccess()
      setDone(true)
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message)
      } else {
        toastError(err instanceof Error ? err.message : 'Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  // TODO(ds): bespoke auth screen kept as-is — buttons carry the login-primary-action
  // shimmer + ink-offset focus rings, inputs are AuthField/SharpnessMeter, errors use
  // auth-error-box, and swaps use auth-* animations; none map to ui/ primitives without
  // visibly redesigning the sign-in language.
  return (
    <div className="login-screen flex h-full min-h-0 w-full items-center justify-center overflow-y-auto bg-[var(--color-ink)] px-6 py-10">
      <div className="auth-ambient" aria-hidden>
        <div className="auth-aurora auth-aurora-a" />
        <div className="auth-aurora auth-aurora-b" />
        <div className="auth-hashmark">#</div>
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-8">
          <BrandLockup wordClassName="text-[var(--color-text)]" />
        </div>

        {!token ? (
          <div className="auth-swap">
            <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
              Invalid reset link.
            </h1>
            <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
              This link is missing its token. Request a new one from the sign-in screen.
            </p>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="login-primary-action mt-6 min-h-11 w-full cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-base font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] sm:text-sm"
            >
              Back to sign in
            </button>
          </div>
        ) : done ? (
          <div className="auth-swap">
            <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
              Password updated.
            </h1>
            <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
              Your password has been changed. Sign in with your new password.
            </p>
            <button
              type="button"
              onClick={() => navigate('/login', { replace: true })}
              className="login-primary-action mt-6 min-h-11 w-full cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-base font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] sm:text-sm"
            >
              Go to sign in
            </button>
          </div>
        ) : (
          <div className="auth-swap">
            <header className="mb-8">
              <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
                Set a new password.
              </h1>
              <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
                Choose a fresh password for your account.
              </p>
            </header>

            <form onSubmit={submit} className="flex flex-col gap-3">
              <AuthField
                label="New password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="8+ characters"
                autoComplete="new-password"
                autoFocus={canAutofocus()}
                required
                index={0}
              />
              <div className="auth-rise" style={{ '--i': 1 } as CSSProperties}>
                <SharpnessMeter password={password} />
              </div>
              <AuthField
                label="Confirm password"
                type="password"
                value={confirm}
                onChange={setConfirm}
                placeholder="Re-enter your password"
                autoComplete="new-password"
                required
                index={2}
              />

              {error && (
                <p role="alert" className="auth-error-box auth-rise rounded-lg px-3 py-2.5 text-xs">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={busy}
                className="login-primary-action mt-2 min-h-11 cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-base font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60 sm:text-sm"
              >
                {busy ? 'Updating…' : 'Update password'}
              </button>
            </form>

            <p className="mt-6 text-center text-sm text-[var(--color-text-dim)]">
              <button
                type="button"
                className="cursor-pointer font-medium text-[var(--color-accent-hover)] hover:underline"
                onClick={() => navigate('/login', { replace: true })}
              >
                Back to sign in
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
