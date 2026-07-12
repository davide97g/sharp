import { fmtDayDivider } from '../lib/util'

export function DayDivider({ iso }: { iso: string }) {
  return (
    <div className="my-2 flex items-center gap-3 px-4">
      <div className="h-px flex-1 bg-[var(--color-border)]" />
      <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-ink)] px-3 py-0.5 text-xs font-medium text-[var(--color-text-dim)]">
        {fmtDayDivider(iso)}
      </span>
      <div className="h-px flex-1 bg-[var(--color-border)]" />
    </div>
  )
}
