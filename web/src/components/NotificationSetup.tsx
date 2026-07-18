import { useState } from 'react'
import { isTauri } from '../lib/notify'
import { useStore } from '../store'

export function NotificationSetup({ compact = false }: { compact?: boolean }) {
  const state = useStore((s) => s.notificationState)
  const enable = useStore((s) => s.enableDesktopNotifications)
  const disable = useStore((s) => s.disableDesktopNotifications)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  if (state === 'install-required') {
    return (
      <div className={cardClass(compact)}>
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
            <InstallIcon />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)]">
              Install sharp for notifications
            </div>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-dim)]">
              On iPhone and iPad, push works from the Home Screen app.
            </p>
            <ol className="mt-2 space-y-1 text-xs leading-relaxed text-[var(--color-text-faint)]">
              <li>1. Open your browser Share menu.</li>
              <li>2. Choose “Add to Home Screen”.</li>
              <li>3. Open sharp from its new icon, then enable notifications.</li>
            </ol>
          </div>
        </div>
      </div>
    )
  }

  const title = isTauri ? 'System notifications' : 'Push notifications'
  const description =
    state === 'subscribed'
      ? 'Enabled for this device. Background and closed-app alerts are ready.'
      : state === 'denied'
        ? 'Blocked by system settings. Allow notifications for sharp, then retry.'
        : state === 'unsupported'
          ? 'This browser does not support standards-based push notifications.'
          : state === 'error'
            ? 'Setup failed. Check HTTPS, service-worker access, and server VAPID settings.'
            : 'Get direct messages, mentions, replies, and reminders on this device.'

  return (
    <div className={cardClass(compact)}>
      <div className="flex min-w-0 flex-wrap items-center gap-3 sm:flex-nowrap">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]">
          <BellIcon />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
            {state === 'subscribed' && (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                On
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-text-faint)]">
            {description}
          </p>
        </div>
        {state === 'subscribed' ? (
          <button
            type="button"
            onClick={() => void run(disable)}
            disabled={busy}
            className="min-h-11 shrink-0 rounded-lg border border-[var(--color-border)] px-3 text-xs font-semibold text-[var(--color-text-dim)] transition-colors hover:border-[var(--color-text-faint)] hover:text-[var(--color-text)] disabled:opacity-50 max-sm:ml-14 max-sm:w-[calc(100%-3.5rem)]"
          >
            {busy ? 'Turning off…' : 'Disable'}
          </button>
        ) : state === 'prompt' || state === 'error' ? (
          <button
            type="button"
            onClick={() => void run(enable)}
            disabled={busy}
            className="min-h-11 shrink-0 rounded-lg bg-[var(--color-accent)] px-4 text-xs font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50 max-sm:ml-14 max-sm:w-[calc(100%-3.5rem)]"
          >
            {busy ? 'Enabling…' : state === 'error' ? 'Retry' : 'Enable'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

function cardClass(compact: boolean) {
  return compact
    ? 'rounded-xl border border-[var(--color-border)] bg-[var(--color-ink)]/45 p-3'
    : 'rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4'
}

function BellIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

function InstallIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  )
}
