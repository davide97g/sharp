import { useEffect, useRef, useState } from 'react'
import type { ChatLayout } from '../lib/types'
import { useStore } from '../store'
import { isTauri } from '../lib/desktopAuth'
import { markOnboardingDone } from '../lib/onboarding'
import { sound } from '../lib/sound'
import { ChatLayoutPicker } from './ChatLayoutChooser'
import { NotificationSetup } from './NotificationSetup'

const STEPS = ['Chat style', 'Notifications'] as const

/**
 * First-login onboarding: a full-screen, skippable stepper.
 * 1. chat style  2. notification permission + DND
 * (Theme is picked during signup on the auth stage; settings can change all
 * of this later.) Rendered app-wide by AppShell until completed or skipped.
 */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const dirRef = useRef<1 | -1>(1)

  // step 1 — chat style
  const setChatLayout = useStore((s) => s.setChatLayout)
  const [layout, setLayout] = useState<ChatLayout>('bubble')

  // step 2 — notifications
  const dnd = useStore((s) => s.dnd)
  const setDnd = useStore((s) => s.setDnd)

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

  // Finish: persist the picked chat layout, then close. DND and notification
  // permission are already applied live within their step.
  async function finish() {
    if (finishing) return
    setFinishing(true)
    try {
      await setChatLayout(layout)
    } catch {
      /* setChatLayout already surfaces errors + rolls back */
    }
    markOnboardingDone()
    onClose()
  }

  const isLast = step === STEPS.length - 1
  const next = () => {
    if (isLast) {
      void finish()
      return
    }
    dirRef.current = 1
    setStep((s) => s + 1)
    sound.tabSwitch()
  }
  const back = () => {
    dirRef.current = -1
    setStep((s) => Math.max(0, s - 1))
    sound.tabSwitch()
  }

  return (
    <div className="fixed inset-0 z-(--z-overlay) flex flex-col bg-[var(--color-ink)] safe-pad">
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
        {/* TODO(ds): auth-screen ghost button — ink-tuned hover (bg-panel, not panel-2) differs from Button ghost; kept for parity. */}
        <button
          onClick={skip}
          className="min-h-11 cursor-pointer rounded-md px-3 text-sm text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]"
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
                className={`flex h-5 w-5 items-center justify-center rounded-full text-3xs ${
                  i === step
                    ? 'bg-[var(--color-accent)] text-white'
                    : i < step
                      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                      : 'bg-[var(--color-panel)]'
                }`}
              >
                {i + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </div>
            {i < STEPS.length - 1 && (
              <div className="hidden h-px w-6 bg-[var(--color-border)] sm:block" />
            )}
          </div>
        ))}
      </div>

      {/* body — direction-aware slide between steps */}
      <div className="flex flex-1 items-start justify-center overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
        <div
          key={step}
          className={`w-full max-w-lg ${dirRef.current === 1 ? 'auth-step-next' : 'auth-step-prev'}`}
        >
          {step === 0 && (
            <StepShell
              title="How should DMs look?"
              subtitle="Pick a layout for 1:1 conversations. You can change this anytime in Settings."
            >
              <ChatLayoutPicker value={layout} onChange={setLayout} />
            </StepShell>
          )}

          {step === 1 && (
            <StepShell
              title="Stay in the loop"
              subtitle="Enable notifications so you don’t miss DMs and mentions."
            >
              <div className="flex flex-col gap-4">
                <NotificationSetup />
                <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold text-[var(--color-text)]">
                      Do not disturb
                    </div>
                    <div className="text-2xs text-[var(--color-text-faint)]">
                      Keep inbox updates, but silence push and toasts.
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
                <p className="mt-2 text-2xs text-[var(--color-text-faint)]">
                  On desktop, sharp uses your system notifications.
                </p>
              )}
            </StepShell>
          )}
        </div>
      </div>

      {/* footer nav */}
      {/* TODO(ds): auth-screen nav buttons kept bespoke — Back uses ink-tuned ghost (hover bg-panel); Continue/Get started carries the login-primary-action shimmer, neither of which the ui Button provides. */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] px-4 py-3 sm:px-6 sm:py-4">
        <button
          onClick={back}
          disabled={step === 0}
          className="min-h-11 cursor-pointer rounded-md px-4 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)] disabled:invisible"
        >
          Back
        </button>
        <button
          onClick={next}
          disabled={finishing}
          className="login-primary-action min-h-11 cursor-pointer rounded-md bg-[var(--color-accent)] px-5 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
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
