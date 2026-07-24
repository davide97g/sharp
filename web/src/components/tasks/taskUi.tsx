// Shared bits for the Tasks mode: priority glyphs (Linear's visual language),
// state dots, label chips, due-date formatting.
import { colorOf } from '../../lib/boardColors'
import type { Project, Task, TaskLabel, TaskPriority, TaskState } from '../../lib/types'

export function TasksGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5.5" />
    </svg>
  )
}

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  0: 'No priority',
  1: 'Urgent',
  2: 'High',
  3: 'Medium',
  4: 'Low',
}

export const PRIORITIES: TaskPriority[] = [0, 1, 2, 3, 4]

/** Linear-style priority glyph: urgent box, signal bars, or a dash for none. */
export function PriorityIcon({ p, size = 14 }: { p: TaskPriority; size?: number }) {
  if (p === 1) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <rect x="1" y="1" width="14" height="14" rx="3" fill="var(--board-orange-fg)" />
        <path
          d="M8 4v5M8 11.5v.5"
          stroke="var(--color-ink)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (p === 0) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
        <path
          d="M3 8h10"
          stroke="var(--color-text-faint)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeDasharray="2 2"
        />
      </svg>
    )
  }
  // high=3 bars, medium=2, low=1 (remaining bars dimmed)
  const lit = p === 2 ? 3 : p === 3 ? 2 : 1
  const bars = [
    { x: 2, y: 9, h: 4 },
    { x: 6.5, y: 6, h: 7 },
    { x: 11, y: 3, h: 10 },
  ]
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width="3"
          height={b.h}
          rx="1"
          fill={i < lit ? 'var(--color-text-dim)' : 'var(--color-border)'}
        />
      ))}
    </svg>
  )
}

/** Colored ring/disc for a workflow state, filled by type progress. */
export function StateDot({ state, size = 12 }: { state: TaskState; size?: number }) {
  const swatch = colorOf(state.color)
  const r = (size - 3) / 2
  const c = size / 2
  if (state.type === 'completed' || state.type === 'canceled') {
    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={c} cy={c} r={r + 1} fill={swatch.fg} />
        <path
          d={
            state.type === 'completed'
              ? `M${c - r / 1.6} ${c} l${r / 1.9} ${r / 1.9} l${r} -${r * 1.1}`
              : `M${c - r / 1.8} ${c - r / 1.8} l${r * 1.2} ${r * 1.2} M${c + r / 1.8} ${c - r / 1.8} l-${r * 1.2} ${r * 1.2}`
          }
          stroke="var(--color-ink)"
          strokeWidth="1.6"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    )
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={c} cy={c} r={r} fill="none" stroke={swatch.fg} strokeWidth="1.6" />
      {state.type === 'started' && <circle cx={c} cy={c} r={r / 2.2} fill={swatch.fg} />}
      {state.type === 'backlog' && (
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="var(--color-ink)"
          strokeWidth="1.6"
          strokeDasharray="2 2"
        />
      )}
    </svg>
  )
}

// TODO(ds): Tag withDot — kept custom for the tighter py-px/text-3xs sizing, the
// title tooltip, and the max-w-24 truncate that ui Tag doesn't express.
export function LabelChip({ label }: { label: TaskLabel }) {
  const swatch = colorOf(label.color)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-1.5 py-px text-3xs text-[var(--color-text-dim)]"
      title={label.name}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: swatch.fg }} />
      <span className="max-w-24 truncate">{label.name}</span>
    </span>
  )
}

export function stateOf(project: Project | undefined, task: Task): TaskState | undefined {
  return project?.states.find((s) => s.id === task.state_id)
}

export function isOpen(state: TaskState | undefined): boolean {
  return !state || (state.type !== 'completed' && state.type !== 'canceled')
}

/** "Jul 24" — red when past, amber when today. */
export function DueBadge({ due }: { due: string }) {
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const overdue = due < todayKey
  const isToday = due === todayKey
  const date = new Date(`${due}T00:00:00`)
  const text = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return (
    <span
      className={`inline-flex items-center gap-1 text-2xs ${
        overdue
          ? 'text-[var(--board-red-fg)]'
          : isToday
            ? 'text-[var(--board-yellow-fg)]'
            : 'text-[var(--color-text-faint)]'
      }`}
      title={`Due ${due}`}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M3 9h18M8 2v4M16 2v4" />
      </svg>
      {text}
    </span>
  )
}

/** Slug for the copy-branch-name flow: `sharp-123-fix-the-thing`, ≤ 60 chars. */
export function branchNameFor(task: Task): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${task.identifier.toLowerCase()}-${slug}`.slice(0, 60).replace(/-+$/, '')
}
