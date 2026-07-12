import { useToasts } from '../lib/toast'

export function Toasts() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={`pointer-events-auto flex max-w-sm cursor-pointer items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg animate-in ${
            t.kind === 'error'
              ? 'border-red-500/40 bg-[#2a1618] text-red-200'
              : t.kind === 'success'
                ? 'border-emerald-500/40 bg-[#132420] text-emerald-200'
                : 'border-[var(--color-border)] bg-[var(--color-panel-2)] text-[var(--color-text)]'
          }`}
        >
          <span className="mt-0.5 text-xs">
            {t.kind === 'error' ? '⚠' : t.kind === 'success' ? '✓' : 'ℹ'}
          </span>
          <span className="leading-snug">{t.message}</span>
        </div>
      ))}
    </div>
  )
}
