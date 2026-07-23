import { useState, type ReactNode } from 'react'
import { useStore, streamShieldOn, streamChannelShielded } from '../../store'
import { StreamRevealConfirm } from './StreamRevealConfirm'

/**
 * Blurs its children behind a Privacy Shield overlay while the shield is
 * enforcing. Pass `channelId` for conversation panes so a per-channel reveal
 * window lifts just that surface; without it the surface only unhides on an
 * "everything" reveal. The reveal button opens the 10-minute choice dialog.
 * Inline labels use `.stream-blur` instead.
 */
export function StreamShield({
  label = 'Private conversation hidden',
  channelId,
  channelName,
  children,
}: {
  label?: string
  channelId?: string
  channelName?: string
  children: ReactNode
}) {
  const shielded = useStore((s) =>
    channelId ? streamChannelShielded(s, channelId) : streamShieldOn(s),
  )
  const [confirming, setConfirming] = useState(false)

  if (!shielded) return <>{children}</>

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="pointer-events-none flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden select-none"
        style={{ filter: 'blur(14px)' }}
        aria-hidden
      >
        {children}
      </div>
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[var(--color-ink)]/30 p-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl border border-amber-500/25 bg-[var(--color-panel)]/85 px-6 py-7 text-center shadow-2xl backdrop-blur-md">
          <span className="shield-halo flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br from-amber-500/25 to-amber-500/5 text-amber-400">
            <ShieldIcon />
          </span>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-amber-500/90">
            Privacy Shield
          </div>
          <div className="text-sm font-semibold text-[var(--color-text)]">{label}</div>
          <div className="max-w-xs text-xs leading-relaxed text-[var(--color-text-dim)]">
            You&apos;re sharing your screen — this stays hidden from everyone watching.
          </div>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)]/80 px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] transition hover:border-amber-500/50 hover:bg-[var(--color-panel-2)]"
          >
            Reveal for 10 min…
          </button>
        </div>
      </div>
      {confirming ? (
        <StreamRevealConfirm
          channelId={channelId}
          channelName={channelName}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  )
}

function ShieldIcon() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  )
}
