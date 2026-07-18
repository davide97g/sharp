import { useEffect, type ReactNode } from 'react'
import { sound } from '../lib/sound'

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Soft thup on open, slightly lower on close — every modal shares this.
  useEffect(() => {
    sound.modalOpen()
    return () => sound.modalClose()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-start sm:p-4 sm:pt-[max(12vh,calc(var(--safe-top)+1.5rem))] sm:pb-[max(1rem,var(--safe-bottom))] sm:pl-[max(1rem,var(--safe-left))] sm:pr-[max(1rem,var(--safe-right))]"
      onMouseDown={onClose}
    >
      <div
        className={`flex min-h-0 w-full flex-col ${wide ? 'max-w-lg' : 'max-w-md'} animate-in border border-[var(--color-border)] bg-[var(--color-panel)] pt-[var(--safe-top)] shadow-2xl max-sm:max-w-none max-sm:rounded-none sm:max-h-[min(76dvh,48rem)] sm:rounded-xl sm:pt-0`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-md text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-[max(1rem,var(--safe-bottom))]">
          {children}
        </div>
      </div>
    </div>
  )
}
