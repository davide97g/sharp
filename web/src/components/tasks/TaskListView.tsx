// Linear-style list: one section per workflow state, dense rows.
import { useMemo } from 'react'
import { useStore } from '../../store'
import { colorOf } from '../../lib/boardColors'
import type { Project, Task } from '../../lib/types'
import { Avatar } from '../Avatar'
import { DueBadge, LabelChip, PriorityIcon, StateDot } from './taskUi'

export function TaskListView({
  project,
  tasks,
  onOpenTask,
  onNewTask,
}: {
  project: Project
  tasks: Task[]
  onOpenTask: (task: Task) => void
  onNewTask: (stateId: string) => void
}) {
  const sections = useMemo(
    () =>
      project.states
        .map((state) => ({
          state,
          tasks: tasks.filter((t) => t.state_id === state.id && !t.parent_id),
        }))
        .filter((s) => s.tasks.length > 0 || s.state.type === 'unstarted'),
    [project.states, tasks],
  )

  return (
    <div className="flex-1 overflow-y-auto pb-8">
      {sections.map(({ state, tasks: sectionTasks }) => {
        const swatch = colorOf(state.color)
        return (
          <section key={state.id}>
            <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-panel)] px-5 py-1.5">
              <StateDot state={state} />
              <span className="text-sm font-semibold" style={{ color: swatch.fg }}>
                {state.name}
              </span>
              <span className="text-xs text-[var(--color-text-faint)]">
                {sectionTasks.length}
              </span>
              <button
                type="button"
                onClick={() => onNewTask(state.id)}
                aria-label={`New task in ${state.name}`}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </div>
            {sectionTasks.map((task) => (
              <TaskRow key={task.id} task={task} onOpen={onOpenTask} />
            ))}
            {sectionTasks.length === 0 && (
              <div className="px-11 py-2 text-xs text-[var(--color-text-faint)]">No tasks</div>
            )}
          </section>
        )
      })}
    </div>
  )
}

export function TaskRow({
  task,
  onOpen,
  showIdentifier = true,
}: {
  task: Task
  onOpen: (task: Task) => void
  showIdentifier?: boolean
}) {
  const users = useStore((s) => s.users)
  const taskLabels = useStore((s) => s.taskLabels)
  const assignee = task.assignee_id ? users[task.assignee_id] : null
  const labels = taskLabels.filter((l) => task.label_ids.includes(l.id))
  return (
    <button
      onClick={() => onOpen(task)}
      className="flex w-full items-center gap-2.5 border-b border-[var(--color-border)] px-5 py-1.5 text-left hover:bg-[var(--color-panel)]"
    >
      <PriorityIcon p={task.priority} />
      {showIdentifier && (
        <span className="w-[4.5rem] shrink-0 font-mono text-[11px] text-[var(--color-text-faint)]">
          {task.identifier}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
        {task.title}
      </span>
      {task.github_links.length > 0 && (
        <span title="Linked on GitHub" className="text-[var(--color-text-faint)]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3v12a3 3 0 1 0 3 3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
        </span>
      )}
      <span className="hidden items-center gap-1.5 sm:flex">
        {labels.slice(0, 3).map((l) => (
          <LabelChip key={l.id} label={l} />
        ))}
      </span>
      {task.due_date && <DueBadge due={task.due_date} />}
      {assignee ? (
        <Avatar id={assignee.id} name={assignee.display_name} size={18} />
      ) : (
        <span className="h-[18px] w-[18px] rounded-full border border-dashed border-[var(--color-border)]" />
      )}
    </button>
  )
}
