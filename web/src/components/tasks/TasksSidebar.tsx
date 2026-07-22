import { useMemo } from 'react'
import { NavLink } from 'react-router-dom'
import { useStore } from '../../store'

export function TasksSidebar() {
  const projects = useStore((s) => s.projects)
  const myTasks = useStore((s) => s.myTasks)

  const active = useMemo(
    () => projects.filter((p) => !p.archived_at).sort((a, b) => a.name.localeCompare(b.name)),
    [projects],
  )

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)]">
      <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--color-ink)] text-[var(--color-accent)] ring-1 ring-[var(--color-border)]">
          <TasksGlyph />
        </span>
        <span className="text-base font-bold tracking-tight">Tasks</span>
      </div>

      <div className="space-y-0.5 px-3 pt-3">
        <NavLink
          to="/tasks"
          end
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              isActive
                ? 'bg-[var(--color-accent-soft)] text-white'
                : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
            }`
          }
        >
          <span>🎯</span>
          <span className="flex-1">My issues</span>
          {myTasks.length > 0 && (
            <span className="rounded-full bg-[var(--color-panel-2)] px-1.5 text-[11px] text-[var(--color-text-faint)]">
              {myTasks.length}
            </span>
          )}
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Projects
        </div>
        <div className="mt-1 space-y-0.5">
          {active.length === 0 && (
            <div className="px-2 py-1.5 text-sm text-[var(--color-text-faint)]">
              No projects yet — create one from Home.
            </div>
          )}
          {active.map((p) => (
            <NavLink
              key={p.id}
              to={`/t/${p.key.toLowerCase()}`}
              className={({ isActive }) =>
                `flex items-center gap-1.5 rounded-md px-2 py-1 text-sm ${
                  isActive
                    ? 'bg-[var(--color-accent-soft)] text-white'
                    : 'text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'
                }`
              }
            >
              <span className="w-4 shrink-0 text-center text-xs">{p.icon || '🎯'}</span>
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              {p.open_count > 0 && (
                <span className="text-[11px] text-[var(--color-text-faint)]">{p.open_count}</span>
              )}
            </NavLink>
          ))}
        </div>
      </nav>

    </aside>
  )
}

export function TasksGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5.5" />
    </svg>
  )
}
