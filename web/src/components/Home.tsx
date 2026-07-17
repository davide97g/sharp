import { useIsMobile } from '../lib/useMediaQuery'
import { Sidebar } from './Sidebar'

export function Home() {
  const isMobile = useIsMobile()

  if (isMobile) {
    return <Sidebar variant="mobile" />
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--color-ink)] text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--color-panel)] text-3xl font-extrabold text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
        #
      </div>
      <h1 className="text-xl font-bold">Welcome to sharp</h1>
      <p className="max-w-sm text-sm text-[var(--color-text-dim)]">
        Pick a channel from the sidebar, or press{' '}
        <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-panel)] px-1.5 py-0.5 text-xs">
          ⌘K
        </kbd>{' '}
        to jump anywhere.
      </p>
    </div>
  )
}
