import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, getServerUrl, setServerUrl } from '../lib/api'
import { ApiRequestError } from '../lib/api'
import { startBrowserLogin } from '../lib/desktopAuth'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { sound } from '../lib/sound'
import { BrandLockup, LOGIN_BRAND_ID } from './BrandLockup'
import { isPasskeyCancellation, loginWithPasskey, supportsPasskeys } from '../lib/passkeys'
import { getThemePreset, setThemePreset, type ThemePreset } from '../lib/theme'
import { ThemePicker } from './ThemePicker'
import { AuthField } from './auth/AuthField'
import { BadgeCard } from './auth/BadgeCard'
import { SharpnessMeter } from './auth/SharpnessMeter'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Autofocus only where it won't pop the mobile keyboard on arrival. */
const canAutofocus = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(pointer: fine)').matches ?? false)

type Mode = 'login' | 'register'

const REG_STEPS = [
  {
    key: 'name',
    label: 'Name',
    title: 'What should we call you?',
    sub: 'Your display name. Teammates see it in chat, docs, and calls.',
  },
  {
    key: 'credentials',
    label: 'Credentials',
    title: 'Make it official.',
    sub: 'Your email signs you in. The password is yours alone — keep it sharp.',
  },
  {
    key: 'look',
    label: 'Look',
    title: 'Pick your look.',
    sub: 'Four house themes. The whole room repaints as you choose — change it later in Settings.',
  },
] as const

/**
 * The auth stage. Login is the fast path ("badge check"); registration is a
 * three-station badge-cutting ceremony — name → credentials → look — that
 * fills in a live member badge as you type and ends with the badge being
 * issued while the workspace boots underneath.
 */
export function Login() {
  const [mode, setMode] = useState<Mode>('login')
  const [busy, setBusy] = useState(false)
  const [server, setServer] = useState(getServerUrl() ?? '')
  const [passkeysEnabled, setPasskeysEnabled] = useState(false)
  const init = useStore((s) => s.init)
  const navigate = useNavigate()

  // login
  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)

  // register
  const [step, setStep] = useState(0)
  const dirRef = useRef<1 | -1>(1)
  const [name, setName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [theme, setTheme] = useState<ThemePreset>(() => getThemePreset())
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [issued, setIssued] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (isTauri || !supportsPasskeys()) return
    api.passkeyConfig().then((value) => setPasskeysEnabled(value.enabled)).catch(() => {})
  }, [])

  // Step 2 has no input to autofocus — land keyboard/SR focus on the heading.
  useEffect(() => {
    if (mode === 'register' && step === 2) headingRef.current?.focus()
  }, [mode, step])

  function switchMode(next: Mode) {
    if (next === mode || busy || issued) return
    sound.modeSwitch()
    setLoginError(null)
    setFormError(null)
    setErrors({})
    dirRef.current = 1
    setStep(0)
    setMode(next)
  }

  async function loginSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (isTauri && server.trim()) {
      setServerUrl(server.trim().replace(/\/+$/, ''))
    }
    setLoginError(null)
    if (loginPassword.length < 8) {
      setLoginError('Password must be at least 8 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await api.login(loginEmail.trim().toLowerCase(), loginPassword)
      await init(res.token, res.user)
      sessionStorage.setItem('sharp.offerPasskey', '1')
      sound.loginSuccess()
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) {
        setLoginError('Email or password doesn’t match.')
      } else if (err instanceof Error) {
        toastError(err.message)
      } else {
        toastError('Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  async function passkeyLogin() {
    if (busy) return
    setBusy(true)
    try {
      const res = await loginWithPasskey()
      await init(res.token, res.user)
      sound.loginSuccess()
      navigate('/', { replace: true })
    } catch (error) {
      if (!isPasskeyCancellation(error)) {
        toastError(error instanceof Error ? error.message : 'Passkey sign-in failed.')
      }
    } finally {
      setBusy(false)
    }
  }

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

  // ── Register wizard ──────────────────────────────────────────────────────

  function regNext() {
    if (step === 0) {
      if (!name.trim()) {
        setErrors((e) => ({ ...e, name: 'Tell us what to call you.' }))
        return
      }
    } else if (step === 1) {
      const next: typeof errors = {}
      if (!EMAIL_RE.test(regEmail.trim())) next.email = 'That email doesn’t look right.'
      if (regPassword.length < 8) next.password = 'Needs at least 8 characters.'
      if (Object.keys(next).length) {
        setErrors((e) => ({ ...e, ...next }))
        return
      }
    }
    setFormError(null)
    dirRef.current = 1
    setStep((s) => Math.min(REG_STEPS.length - 1, s + 1))
    sound.tabSwitch()
  }

  function regBack() {
    dirRef.current = -1
    setStep((s) => Math.max(0, s - 1))
    sound.tabSwitch()
  }

  function blurRegEmail() {
    if (regEmail.trim() && !EMAIL_RE.test(regEmail.trim())) {
      setErrors((e) => ({ ...e, email: 'That email doesn’t look right.' }))
    }
  }

  function blurRegPassword() {
    if (regPassword && regPassword.length < 8) {
      setErrors((e) => ({ ...e, password: 'Needs at least 8 characters.' }))
    }
  }

  async function register(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    if (isTauri && server.trim()) {
      setServerUrl(server.trim().replace(/\/+$/, ''))
    }
    setFormError(null)
    setBusy(true)
    try {
      const res = await api.register(regEmail.trim().toLowerCase(), regPassword, name.trim())
      sound.loginSuccess()
      setIssued(true)
      try {
        // init() sets store.token synchronously, which flips the app boot to
        // authed and redirects /login → / immediately. Hold the route change
        // for a beat so the issued ceremony (check draw + sheen) actually
        // plays before the app shell takes over.
        await new Promise((r) => setTimeout(r, 1600))
        await init(res.token, res.user)
        sessionStorage.setItem('sharp.offerPasskey', '1')
        navigate('/', { replace: true })
      } catch (bootErr) {
        setIssued(false)
        if (bootErr instanceof Error) toastError(bootErr.message)
        else toastError('Something went wrong.')
      }
    } catch (err) {
      if (err instanceof ApiRequestError) {
        if (err.status === 409) {
          dirRef.current = -1
          setStep(1)
          setErrors((e2) => ({
            ...e2,
            email: 'That email is already registered — try signing in instead.',
          }))
        } else if (err.status === 400) {
          dirRef.current = -1
          setStep(1)
          setFormError(err.message)
        } else {
          // e.g. 403 signups disabled — surface where the user stands.
          setFormError(err.message)
        }
      } else if (err instanceof Error) {
        toastError(err.message)
      } else {
        toastError('Something went wrong.')
      }
    } finally {
      setBusy(false)
    }
  }

  const idx = isTauri ? 1 : 0 // stagger offset when the Tauri server field leads

  return (
    <div className="login-screen flex h-full min-h-0 w-full flex-col overflow-hidden md:flex-row">
      {/* Branding panel — art + official lockup (splash FLIP target).
          In register mode the live member badge joins the stack. */}
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
          {mode === 'register' && (
            <div className="auth-swap mb-5 hidden md:block">
              <BadgeCard name={name} email={regEmail} issued={issued} />
              <p className="mt-3 max-w-[300px] text-xs leading-relaxed text-white/60">
                Your badge fills in as you type.
              </p>
            </div>
          )}
          <BrandLockup
            id={LOGIN_BRAND_ID}
            wordClassName="text-white drop-shadow-[0_1px_12px_rgba(0,0,0,0.45)]"
          />
          {mode === 'login' && (
            <p className="hidden max-w-xs text-sm leading-relaxed text-white/70 md:block">
              Your work, your team, your flow — all in one place.
            </p>
          )}
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-ink)] px-6 py-8 sm:px-10 md:py-10 lg:px-16">
        {/* Ambient backdrop — accent auroras + `#` watermark. Repaints live
            with the theme tokens. */}
        <div className="auth-ambient" aria-hidden>
          <div className="auth-aurora auth-aurora-a" />
          <div className="auth-aurora auth-aurora-b" />
          <div className="auth-hashmark">#</div>
        </div>

        <div className="relative my-auto w-full max-w-sm self-center">
          {mode === 'login' ? (
            /* ── Login: the fast path ── */
            <div className="auth-swap">
              <header className="mb-8">
                <h1 className="login-heading text-2xl font-bold tracking-tight text-[var(--color-text)]">
                  Welcome back.
                </h1>
                <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
                  Sign in to your workspace.
                </p>
              </header>

              <form onSubmit={loginSubmit} className="flex flex-col gap-3">
                {isTauri && (
                  <AuthField
                    label="Server URL"
                    type="url"
                    placeholder="https://chat.example.com"
                    value={server}
                    onChange={setServer}
                    autoComplete="url"
                    index={0}
                  />
                )}
                <AuthField
                  label="Email"
                  type="email"
                  value={loginEmail}
                  onChange={setLoginEmail}
                  placeholder="you@example.com"
                  autoComplete="email"
                  autoFocus={canAutofocus()}
                  required
                  index={idx}
                />
                <AuthField
                  label="Password"
                  type="password"
                  value={loginPassword}
                  onChange={setLoginPassword}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  required
                  index={idx + 1}
                />

                {loginError && (
                  <p role="alert" className="auth-error-box auth-rise rounded-lg px-3 py-2.5 text-xs">
                    {loginError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={busy}
                  className="login-primary-action mt-2 min-h-11 cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-base font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60 sm:text-sm"
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>

              {passkeysEnabled && (
                <>
                  <div className="my-4 flex items-center gap-3 text-xs text-[var(--color-text-faint)]">
                    <span className="h-px flex-1 bg-[var(--color-border)]" />
                    or
                    <span className="h-px flex-1 bg-[var(--color-border)]" />
                  </div>
                  <button
                    type="button"
                    onClick={() => void passkeyLogin()}
                    disabled={busy}
                    className="min-h-11 w-full cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5 text-base font-semibold text-[var(--color-text)] transition hover:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] disabled:opacity-60 sm:text-sm"
                  >
                    Sign in with passkey
                  </button>
                </>
              )}

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
                    className="min-h-11 w-full cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5 text-base font-semibold text-[var(--color-text)] transition hover:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] disabled:opacity-60 sm:text-sm"
                  >
                    Log in with browser
                  </button>
                </>
              )}

              <ModeToggle mode={mode} onSwitch={switchMode} />
            </div>
          ) : issued ? (
            /* ── Badge issued: the ceremony beat while the workspace boots ── */
            <div className="auth-swap flex flex-col items-center gap-6 py-4 text-center">
              {/* On md+ the brand-panel badge is the star; the centered card is
                  the ceremony anchor on small screens only. */}
              <div className="md:hidden">
                <BadgeCard name={name} email={regEmail} issued />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight text-[var(--color-text)]">
                  You’re in{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ''}.
                </h1>
                <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">
                  Setting up your workspace…
                </p>
              </div>
              <div className="auth-progress" aria-hidden />
            </div>
          ) : (
            /* ── Register: three stations ── */
            <div className="auth-swap">
              <ol className="mb-6 flex items-start gap-2" aria-label="Account setup progress">
                {REG_STEPS.map((s, i) => (
                  <li key={s.key} className="flex-1">
                    <span
                      className={`block h-1 rounded-full transition-colors duration-300 ${
                        i <= step ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
                      }`}
                    />
                    <button
                      type="button"
                      disabled={i >= step || busy}
                      onClick={() => {
                        dirRef.current = -1
                        setStep(i)
                        sound.tabSwitch()
                      }}
                      aria-current={i === step ? 'step' : undefined}
                      className={`mt-1.5 cursor-pointer text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors disabled:cursor-default ${
                        i === step
                          ? 'text-[var(--color-text)]'
                          : i < step
                            ? 'text-[var(--color-accent-hover)] hover:underline'
                            : 'text-[var(--color-text-faint)]'
                      }`}
                    >
                      {s.label}
                    </button>
                  </li>
                ))}
              </ol>

              {/* Identity anchor on small screens (desktop sees the full card
                  in the brand panel). */}
              <div className="mb-5 md:hidden">
                <BadgeCard compact name={name} email={regEmail} />
              </div>

              <div key={step} className={dirRef.current === 1 ? 'auth-step-next' : 'auth-step-prev'}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-accent-hover)]">
                  {`0${step + 1} — ${REG_STEPS[step].label}`}
                </p>
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  className="text-2xl font-bold tracking-tight text-[var(--color-text)] focus:outline-none"
                >
                  {REG_STEPS[step].title}
                </h1>
                <p className="mt-1.5 text-sm text-[var(--color-text-dim)]">{REG_STEPS[step].sub}</p>

                <form
                  onSubmit={
                    step === REG_STEPS.length - 1
                      ? register
                      : (e) => {
                          e.preventDefault()
                          regNext()
                        }
                  }
                  className="mt-6 flex flex-col gap-3"
                >
                  {step === 0 && (
                    <AuthField
                      label="Display name"
                      value={name}
                      onChange={(v) => {
                        setName(v)
                        if (errors.name) setErrors((e) => ({ ...e, name: undefined }))
                      }}
                      error={errors.name}
                      hint="Real name, alias, callsign — whatever sticks."
                      placeholder="Ada Lovelace"
                      autoComplete="name"
                      autoFocus={canAutofocus()}
                      required
                      index={0}
                    />
                  )}

                  {step === 1 && (
                    <>
                      {isTauri && (
                        <AuthField
                          label="Server URL"
                          type="url"
                          placeholder="https://chat.example.com"
                          value={server}
                          onChange={setServer}
                          autoComplete="url"
                          index={0}
                        />
                      )}
                      <AuthField
                        label="Email"
                        type="email"
                        value={regEmail}
                        onChange={(v) => {
                          setRegEmail(v)
                          if (errors.email) setErrors((e) => ({ ...e, email: undefined }))
                        }}
                        onBlur={blurRegEmail}
                        error={errors.email}
                        placeholder="you@example.com"
                        autoComplete="email"
                        autoFocus={canAutofocus()}
                        required
                        index={idx}
                      />
                      <AuthField
                        label="Password"
                        type="password"
                        value={regPassword}
                        onChange={(v) => {
                          setRegPassword(v)
                          if (errors.password) setErrors((e) => ({ ...e, password: undefined }))
                        }}
                        onBlur={blurRegPassword}
                        error={errors.password}
                        placeholder="8+ characters"
                        autoComplete="new-password"
                        required
                        index={idx + 1}
                      />
                      <div className="auth-rise" style={{ '--i': idx + 2 } as CSSProperties}>
                        <SharpnessMeter password={regPassword} />
                      </div>
                    </>
                  )}

                  {step === 2 && (
                    <div className="auth-rise" style={{ '--i': 0 } as CSSProperties}>
                      <ThemePicker
                        value={theme}
                        onChange={(p) => {
                          setTheme(p)
                          setThemePreset(p)
                          sound.previewTick()
                        }}
                      />
                    </div>
                  )}

                  {formError && (
                    <p role="alert" className="auth-error-box auth-rise rounded-lg px-3 py-2.5 text-xs">
                      {formError}
                    </p>
                  )}

                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={regBack}
                      disabled={step === 0 || busy}
                      className="min-h-11 flex-1 cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-dim)] transition hover:border-[var(--color-text-faint)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)] disabled:invisible"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={busy}
                      className="login-primary-action min-h-11 flex-[2] cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--color-accent-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 focus:ring-offset-[var(--color-ink)] disabled:opacity-60"
                    >
                      {step === REG_STEPS.length - 1
                        ? busy
                          ? 'Cutting your badge…'
                          : 'Create account'
                        : 'Continue'}
                    </button>
                  </div>
                </form>
              </div>

              <ModeToggle mode={mode} onSwitch={switchMode} />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function ModeToggle({ mode, onSwitch }: { mode: Mode; onSwitch: (m: Mode) => void }) {
  return (
    <p className="mt-6 text-center text-sm text-[var(--color-text-dim)]">
      {mode === 'login' ? 'New here? ' : 'Already have an account? '}
      <button
        type="button"
        className="cursor-pointer font-medium text-[var(--color-accent-hover)] hover:underline"
        onClick={() => onSwitch(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login' ? 'Create an account' : 'Sign in'}
      </button>
    </p>
  )
}
