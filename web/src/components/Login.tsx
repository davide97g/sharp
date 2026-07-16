import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getServerUrl, setServerUrl } from '../lib/api'
import { ApiRequestError } from '../lib/api'
import { startBrowserLogin } from '../lib/desktopAuth'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { BrandLockup, LOGIN_BRAND_ID } from './BrandLockup'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export function Login() {
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
    <div className="login-screen flex min-h-full w-full flex-col md:flex-row">
      {/* Branding panel — art + official lockup (splash FLIP target).
          Stacks as a top strip on small screens; half-width on md+. */}
      <aside className="login-brand relative h-44 w-full shrink-0 overflow-hidden md:h-auto md:min-h-full md:w-[48%]">
        <img
          src="/login-art.png"
          alt=""
          draggable={false}
          className="login-brand-art absolute inset-0 h-full w-full object-cover"
        />
        <div className="login-brand-veil pointer-events-none absolute inset-0" />
        {/* Whole copy stack stays invisible until splash unmounts — prevents
            tagline ghosting under the flying lockup mid-handoff. */}
        <div className="login-brand-copy absolute inset-x-0 bottom-0 flex flex-col gap-2 p-5 md:gap-3 md:p-10 md:pb-12">
          <BrandLockup
            id={LOGIN_BRAND_ID}
            wordClassName="text-white drop-shadow-[0_1px_12px_rgba(0,0,0,0.45)]"
          />
          <p className="hidden max-w-xs text-sm leading-relaxed text-white/70 md:block">
            Your work, your team, your flow — all in one place.
          </p>
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative flex flex-1 flex-col justify-center bg-[var(--color-ink)] px-6 py-8 sm:px-10 md:py-10 lg:px-16">
        <div className="mx-auto w-full max-w-sm animate-in">
          <header className="login-intro mb-8">
            <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
              {mode === 'login' ? 'Welcome back' : 'Create your account'}
            </h1>
            <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
              {mode === 'login'
                ? 'Sign in to your workspace'
                : 'Get started with sharp'}
            </p>
          </header>

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
              className="login-primary-action mt-2 rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60"
            >
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          {isTauri && (
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
      </main>
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
    <label className="login-field flex flex-col gap-1.5">
      <span className="login-field-label text-xs font-medium text-[var(--color-text-dim)]">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        className="login-field-input rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
      />
    </label>
  )
}
