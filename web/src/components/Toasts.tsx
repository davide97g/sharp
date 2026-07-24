import { useToasts } from '../lib/toast'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  return (
    <div
      className="pointer-events-none fixed z-(--z-toast) flex flex-col gap-2"
      style={{
        right: 'max(1rem, env(safe-area-inset-right, 0px))',
        bottom: 'max(1rem, calc(var(--mobile-tab-h, 0px) + 0.5rem))',
      }}
    >
      {toasts.map((t) => {
        if (t.kind === 'notify') {
          return (
            <div
              key={t.id}
              data-huddle={t.message === 'started a huddle' || undefined}
              onClick={() => {
                t.onClick?.()
                dismiss(t.id)
              }}
              className="notify-toast group pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] cursor-pointer items-start gap-3 overflow-hidden rounded-xl border border-[var(--color-accent)]/50 bg-gradient-to-br from-[var(--color-panel-2)] to-[var(--color-accent-soft)] px-3.5 py-3 shadow-[0_8px_30px_-6px_rgba(124,108,255,0.55)] ring-1 ring-inset ring-white/5 animate-notify"
            >
              {/* pulsing accent avatar bubble */}
              <div className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--color-accent-hover)] to-[var(--color-accent)] text-sm font-bold text-white shadow-lg">
                {t.initial ?? '🔔'}
                <span className="absolute inset-0 rounded-full ring-2 ring-[var(--color-accent-hover)]/60 animate-ping-slow" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold tracking-tight text-[var(--color-text)]">
                  {t.title ?? 'New message'}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-[var(--color-text)]/80">
                  {t.message}
                </div>
              </div>
            </div>
          )
        }
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`pointer-events-auto flex max-w-sm cursor-pointer items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg animate-in ${
              t.kind === 'error'
                ? 'border-danger-fg/40 bg-danger-soft text-danger-fg'
                : t.kind === 'success'
                  ? 'border-success-fg/40 bg-success-soft text-success-fg'
                  : 'border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-text)]'
            }`}
          >
            <span className="mt-0.5 text-xs">
              {t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : 'ℹ'}
            </span>
            <span className="leading-snug">{t.message}</span>
          </div>
        )
      })}
    </div>
  )
}
