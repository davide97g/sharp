import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getServerUrl, setServerUrl } from '../lib/api'
import { ApiRequestError } from '../lib/api'
import { startBrowserLogin } from '../lib/desktopAuth'
import type { AuthResponse } from '../lib/types'
import { useStore } from '../store'
import { toastError } from '../lib/toast'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * When `onAuthenticated` is provided, a successful login/register calls it with
 * the auth response instead of initializing the app + navigating. Used by the
 * `/desktop-auth` browser bridge, which only needs the token to mint a code.
 */
export function Login({
  onAuthenticated,
}: {
  onAuthenticated?: (res: AuthResponse) => void | Promise<void>
} = {}) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [server, setServer] = useState(getServerUrl() ?? '')
  const [busy, setBusy] = useState(false)
  const init = useStore((s) => s.init)
  const enableDesktopNotifications = useStore((s) => s.enableDesktopNotifications)
  const navigate = useNavigate()

  async function browserLogin() {
    if (busy) return
    const url = server.trim().replace(/\/+$/, '')
    if (!url) {
      toastError('Enter your Server URL first.')
      return
    }
    setServerUrl(url)
    setBusy(true)
    try {
      await startBrowserLogin()
    } catch {
      toastError('Could not open the browser.')
    } finally {
      setBusy(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (isTauri && server.trim()) {
      setServerUrl(server.trim().replace(/\/+$/, ''))
    }
    if (password.length < 8) {
      toastError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const res =
        mode === 'login'
          ? await api.login(email.trim().toLowerCase(), password)
          : await api.register(email.trim().toLowerCase(), password, displayName.trim())
      if (onAuthenticated) {
        await onAuthenticated(res)
        return
      }
      await init(res.token, res.user)
      // First sign-in: ask for notification permission once, while we still have
      // the click gesture. Skip if the user already granted or denied it before.
      if (typeof Notification === 'undefined' || Notification.permission === 'default') {
        void enableDesktopNotifications()
      }
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiRequestError) toastError(err.message)
      else if (err instanceof Error) toastError(err.message)
      else toastError('Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--color-ink)] p-6">
      <div className="w-full max-w-sm animate-in">
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--color-panel)] text-3xl font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
            #
          </div>
          <h1 className="text-2xl font-bold tracking-tight">
            sharp
          </h1>
          <p className="text-sm text-[var(--color-text-dim)]">
            {mode === 'login' ? 'Sign in to your workspace' : 'Create your account'}
          </p>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-3">
          {isTauri && (
            <Field
              label="Server URL"
              type="url"
              placeholder="https://chat.example.com"
              value={server}
              onChange={setServer}
              autoComplete="url"
            />
          )}
          {mode === 'register' && (
            <Field
              label="Display name"
              value={displayName}
              onChange={setDisplayName}
              placeholder="Ada Lovelace"
              required
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            placeholder="••••••••"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60"
          >
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        {isTauri && !onAuthenticated && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-[var(--color-text-faint)]">
              <span className="h-px flex-1 bg-[var(--color-border)]" />
              or
              <span className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
            <button
              type="button"
              onClick={browserLogin}
              disabled={busy}
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text)] transition hover:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] disabled:opacity-60"
            >
              Log in with browser
            </button>
          </>
        )}

        <div className="mt-6 text-center text-sm text-[var(--color-text-dim)]">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button
            className="font-medium text-[var(--color-accent-hover)] hover:underline"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Register' : 'Sign in'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  autoComplete,
  required,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  autoComplete?: string
  required?: boolean
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-[var(--color-text-dim)]">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
      />
    </label>
  )
}
