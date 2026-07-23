import { useState, type ReactNode } from 'react'
import { useStore, streamShieldOn } from '../../store'
import { StreamRevealConfirm } from './StreamRevealConfirm'

/**
 * Blurs its children behind an overlay while the streaming privacy shield is
 * enforcing. The reveal button opens the 10-minute confirm dialog. Wrap full
 * panes (private/DM conversation, Sharpy) — inline labels use `.stream-blur`.
 */
export function StreamShield({
  label = 'Private conversation hidden',
  children,
}: {
  label?: string
  children: ReactNode
}) {
  const shielded = useStore(streamShieldOn)
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
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-[var(--color-panel)]/40 p-4 text-center">
        <ShieldIcon />
        <div className="text-sm font-semibold text-[var(--color-text)]">{label}</div>
        <div className="max-w-xs text-xs text-[var(--color-text-dim)]">
          You&apos;re streaming — this content is hidden from your shared screen.
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-panel-2)]"
        >
          Reveal for 10 min
        </button>
      </div>
      {confirming ? <StreamRevealConfirm onClose={() => setConfirming(false)} /> : null}
    </div>
  )
}

function ShieldIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--color-text-faint)]"
      aria-hidden
    >
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  )
}
