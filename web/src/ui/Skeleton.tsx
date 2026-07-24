import { cn } from './cn'

/** `.skeleton` shimmer CSS lives in index.css. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />
}

/** Loading placeholder matching the doc editor's title bar + three body lines. */
export function EditorSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-10">
      <div className="skeleton mb-4 h-10 w-2/3 rounded-lg" />
      <div className="skeleton mb-2 h-4 rounded" />
      <div className="skeleton mb-2 h-4 w-5/6 rounded" />
      <div className="skeleton h-4 w-4/6 rounded" />
    </div>
  )
}
