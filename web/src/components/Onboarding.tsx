import { useEffect, useState } from 'react'
import type { ChatLayout } from '../lib/types'
import { useStore } from '../store'
import { isTauri } from '../lib/desktopAuth'
import {
  getThemeChoice,
  markOnboardingDone,
  setThemeChoice,
  type ThemeChoice,
} from '../lib/onboarding'
import { ChatLayoutPicker } from './ChatLayoutChooser'
import { NotificationSetup } from './NotificationSetup'

const STEPS = ['Chat style', 'Notifications', 'Appearance'] as const

/**
 * First-login onboarding: a full-screen, skippable stepper.
 * 1. chat style  2. notification permission + DND  3. theme (setup choice only)
 * Rendered app-wide by AppShell until the client has completed or skipped it.
 */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)

  // step 1 — chat style
  const setChatLayout = useStore((s) => s.setChatLayout)
  const [layout, setLayout] = useState<ChatLayout>('bubble')

  // step 2 — notifications
  const dnd = useStore((s) => s.dnd)
  const setDnd = useStore((s) => s.setDnd)

  // step 3 — theme (persisted, applied later)
  const [theme, setTheme] = useState<ThemeChoice>(() => getThemeChoice())

  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') finish()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Skip: leave every choice at its current/default state, just don't ask again.
  function skip() {
    markOnboardingDone()
    onClose()
  }

  // Finish: persist the picked chat layout + theme, then close. DND and
  // notification permission are already applied live within their step.
  async function finish() {
    if (finishing) return
    setFinishing(true)
    setThemeChoice(theme)
    try {
      await setChatLayout(layout)
    } catch {
      /* setChatLayout already surfaces errors + rolls back */
    }
    markOnboardingDone()
    onClose()
  }

  const isLast = step === STEPS.length - 1
  const next = () => (isLast ? void finish() : setStep((s) => s + 1))
  const back = () => setStep((s) => Math.max(0, s - 1))

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[var(--color-ink)] safe-pad">
      {/* header: brand + skip + step progress */}
      <div className="flex items-center justify-between px-4 pt-[max(1rem,var(--titlebar-h))] pb-2 sm:px-6 sm:pt-[max(1.5rem,var(--titlebar-h))]">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-panel)] text-lg font-extrabold text-[var(--color-accent)]">
            #
          </span>
          <span className="text-sm font-semibold text-[var(--color-text-dim)]">
            Welcome to sharp
          </span>
        </div>
        <button
          onClick={skip}
          className="min-h-11 rounded-md px-3 text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
        >
          Skip for now
        </button>
      </div>

      {/* step indicator */}
      <div className="flex items-center justify-center gap-1 overflow-x-auto px-4 py-3 sm:gap-2 sm:px-6 sm:py-4">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2">
            <div
              className={`flex min-h-9 items-center gap-2 rounded-full px-2 py-1 text-xs font-medium transition sm:px-3 ${
                i === step
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-text)]'
                  : i < step
                    ? 'text-[var(--color-accent-hover)]'
                    : 'text-[var(--color-text-faint)]'
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  i <= step
                    ? 'bg-[var(--color-accent)] text-white'
                    : 'border border-[var(--color-border)]'
                }`}
              >
                {i < step ? '✓' : i + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <span className="h-px w-4 bg-[var(--color-border)] sm:w-6" />
            )}
          </div>
        ))}
      </div>

      {/* step body */}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-4 sm:px-6">
        <div className="w-full max-w-xl animate-in pb-6">
          {step === 0 && (
            <StepShell
              title="How should chats look?"
              subtitle="Pick a style for your direct messages. You can change it anytime in Settings."
            >
              <ChatLayoutPicker value={layout} onChange={setLayout} />
            </StepShell>
          )}

          {step === 1 && (
            <StepShell
              title="Stay in the loop"
              subtitle="Get notified about direct messages, mentions, and replies — even when sharp isn't focused."
            >
              <div className="flex flex-col gap-3">
                <NotificationSetup />
                <label className="flex min-h-14 items-center justify-between gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--color-text)]">
                      Do not disturb
                    </div>
                    <div className="text-[11px] text-[var(--color-text-faint)]">
                      Keep inbox items but silence push and pop-ups.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={dnd}
                    onChange={(e) => void setDnd(e.target.checked)}
                    className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                  />
                </label>
              </div>
              {isTauri && (
                <p className="mt-2 text-[11px] text-[var(--color-text-faint)]">
                  On desktop, sharp uses your system notifications.
                </p>
              )}
            </StepShell>
          )}

          {step === 2 && (
            <StepShell
              title="Pick your look"
              subtitle="Choose a theme to start with. Light mode is coming soon — your choice is saved for when it lands."
            >
              <div className="flex gap-3">
                <ThemeCard
                  theme="dark"
                  title="Dark"
                  selected={theme === 'dark'}
                  onSelect={() => setTheme('dark')}
                />
                <ThemeCard
                  theme="light"
                  title="Light"
                  selected={theme === 'light'}
                  onSelect={() => setTheme('light')}
                />
              </div>
            </StepShell>
          )}
        </div>
      </div>

      {/* footer nav */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3 sm:px-6 sm:py-4">
        <button
          onClick={back}
          disabled={step === 0}
          className="min-h-11 rounded-md px-4 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] disabled:invisible"
        >
          Back
        </button>
        <button
          onClick={next}
          disabled={finishing}
          className="min-h-11 rounded-md bg-[var(--color-accent)] px-5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
        >
          {isLast ? (finishing ? 'Finishing…' : 'Get started') : 'Continue'}
        </button>
      </div>
    </div>
  )
}

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: React.ReactNode
}) {
  return (
    <div>
      <h1 className="text-2xl font-bold text-[var(--color-text)]">{title}</h1>
      <p className="mt-1 mb-5 text-sm text-[var(--color-text-dim)]">{subtitle}</p>
      {children}
    </div>
  )
}

// A tiny non-interactive mockup of each theme.
function ThemeCard({
  theme,
  title,
  selected,
  onSelect,
}: {
  theme: ThemeChoice
  title: string
  selected: boolean
  onSelect: () => void
}) {
  const dark = theme === 'dark'
  const bg = dark ? '#0e0e11' : '#f5f5f7'
  const panel = dark ? '#1c1c22' : '#ffffff'
  const line = dark ? '#33333d' : '#d9d9de'
  const text = dark ? '#e6e6ea' : '#1a1a1f'
  return (
    <button
      onClick={onSelect}
      className={`flex-1 rounded-xl border p-2 text-left transition ${
        selected
          ? 'border-[var(--color-accent)] ring-2 ring-[var(--color-accent-soft)]'
          : 'border-[var(--color-border)] hover:border-[var(--color-text-faint)]'
      }`}
    >
      <div
        className="flex flex-col gap-1.5 rounded-lg p-3"
        style={{ backgroundColor: bg }}
      >
        <div
          className="h-3 w-1/2 rounded"
          style={{ backgroundColor: '#7c6cff' }}
        />
        {[0.9, 0.7].map((w, i) => (
          <div
            key={i}
            className="rounded px-2 py-1.5"
            style={{ backgroundColor: panel, border: `1px solid ${line}`, width: `${w * 100}%` }}
          >
            <div
              className="h-1.5 w-3/4 rounded"
              style={{ backgroundColor: text, opacity: 0.5 }}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 px-1 text-sm font-semibold text-[var(--color-text)]">
        {title}
        {theme === 'light' && (
          <span className="ml-1 text-[11px] font-normal text-[var(--color-text-faint)]">
            (soon)
          </span>
        )}
      </div>
    </button>
  )
}
