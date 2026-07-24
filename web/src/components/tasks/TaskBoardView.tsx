import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../store'
import type { Project, Task } from '../../lib/types'
import { Avatar } from '../Avatar'
import { colorOf } from '../../lib/boardColors'
import { DueBadge, LabelChip, PriorityIcon } from './taskUi'
import { useTaskDnd, type TaskColumnData } from './useTaskDnd'
import { IconButton } from '../../ui'

export function TaskBoardView({
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
  const patchTask = useStore((s) => s.patchTask)
  const scrollRef = useRef<HTMLDivElement>(null)

  const columns: TaskColumnData[] = useMemo(
    () =>
      project.states.map((state) => ({
        state,
        tasks: tasks.filter((t) => t.state_id === state.id && !t.parent_id),
      })),
    [project.states, tasks],
  )

  const onDrop = useCallback(
    (taskId: string, stateId: string, sortOrder: string) => {
      void patchTask(taskId, { state_id: stateId, sort_order: sortOrder })
    },
    [patchTask],
  )

  const dnd = useTaskDnd({ columns, canEdit: true, scrollRef, onDrop })
  const ghostTask = dnd.ghost ? tasks.find((t) => t.id === dnd.ghost?.taskId) : null

  return (
    <div ref={scrollRef} className="flex flex-1 gap-3 overflow-x-auto px-3 pb-5 pt-4 sm:px-5 max-sm:snap-x max-sm:snap-mandatory">
      {columns.map((col) => (
        <TaskColumn
          key={col.state.id}
          project={project}
          column={col}
          dnd={dnd}
          dropIndex={dnd.drop?.stateId === col.state.id ? dnd.drop.index : null}
          onOpenTask={onOpenTask}
          onNewTask={onNewTask}
        />
      ))}
      {ghostTask &&
        dnd.ghost &&
        createPortal(
          <div
            className="pointer-events-none fixed z-50 rotate-2 opacity-90"
            style={{ left: dnd.ghost.x, top: dnd.ghost.y, width: dnd.ghost.w }}
          >
            <TaskCardTile project={project} task={ghostTask} dragging={false} />
          </div>,
          document.body,
        )}
    </div>
  )
}

function TaskColumn({
  project,
  column,
  dnd,
  dropIndex,
  onOpenTask,
  onNewTask,
}: {
  project: Project
  column: TaskColumnData
  dnd: ReturnType<typeof useTaskDnd>
  dropIndex: number | null
  onOpenTask: (task: Task) => void
  onNewTask: (stateId: string) => void
}) {
  const swatch = colorOf(column.state.color)
  // Subtle status-color wash: tint the panel + border with a low-alpha mix of the
  // state's accent so columns read by color even when a workspace theme is set.
  const tint = swatch.fg
  const columnRef = useCallback(
    (el: HTMLElement | null) => dnd.registerColumn(column.state.id, el),
    [dnd, column.state.id],
  )

  const items: ReactNode[] = []
  const line = (
    <div key="drop-line" className="mx-0.5 my-0.5 h-0.5 rounded-full bg-[var(--color-accent)]" />
  )
  let nonDragged = 0
  let placed = false
  for (const task of column.tasks) {
    if (!placed && dropIndex !== null && nonDragged === dropIndex) {
      items.push(line)
      placed = true
    }
    items.push(
      <TaskCard
        key={task.id}
        project={project}
        task={task}
        dragging={task.id === dnd.dragTaskId}
        dnd={dnd}
        onOpen={onOpenTask}
      />,
    )
    if (task.id !== dnd.dragTaskId) nonDragged++
  }
  if (!placed && dropIndex !== null && nonDragged === dropIndex) items.push(line)

  return (
    <div
      ref={columnRef}
      className="flex max-h-full w-[280px] shrink-0 flex-col overflow-hidden rounded-xl border max-sm:w-[85vw] max-sm:max-w-[320px] max-sm:snap-start"
      style={{
        borderColor: `color-mix(in srgb, ${tint} 20%, var(--color-border))`,
        background: `linear-gradient(to bottom, color-mix(in srgb, ${tint} 8%, var(--color-panel)), color-mix(in srgb, ${tint} 3%, var(--color-panel)) 160px)`,
      }}
    >
      <div
        className="flex items-center gap-2 px-3 pb-2 pt-3"
        style={{ boxShadow: `inset 0 1px 0 color-mix(in srgb, ${tint} 45%, transparent)` }}
      >
        <span
          className="flex min-w-0 select-none items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold"
          style={{ backgroundColor: swatch.bg, color: swatch.fg }}
        >
          <span className="truncate">{column.state.name}</span>
        </span>
        <span className="text-xs text-[var(--color-text-faint)]">{column.tasks.length}</span>
        <IconButton
          size="sm"
          className="ml-auto"
          label={`New task in ${column.state.name}`}
          onClick={() => onNewTask(column.state.id)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </IconButton>
      </div>
      <div className="flex min-h-[8px] flex-col gap-1.5 overflow-y-auto px-2 pb-3">{items}</div>
    </div>
  )
}

function TaskCard({
  project,
  task,
  dragging,
  dnd,
  onOpen,
}: {
  project: Project
  task: Task
  dragging: boolean
  dnd: ReturnType<typeof useTaskDnd>
  onOpen: (task: Task) => void
}) {
  const cardRef = useCallback(
    (el: HTMLElement | null) => dnd.registerCard(task.id, el),
    [dnd, task.id],
  )
  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      onPointerDown={(e) => dnd.startDrag(e, task.id)}
      onClick={() => {
        if (!dnd.consumeSuppressClick()) onOpen(task)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(task)
        }
      }}
      className={`${dragging ? 'opacity-30' : ''} cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]`}
    >
      <TaskCardTile project={project} task={task} dragging={dragging} />
    </div>
  )
}

export function TaskCardTile({
  project,
  task,
  dragging,
}: {
  project: Project
  task: Task
  dragging: boolean
}) {
  const users = useStore((s) => s.users)
  const taskLabels = useStore((s) => s.taskLabels)
  const assignee = task.assignee_id ? users[task.assignee_id] : null
  const labels = taskLabels.filter((l) => task.label_ids.includes(l.id))
  return (
    <div
      className={`cursor-pointer select-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 transition-colors hover:border-[var(--color-accent)] focus-within:ring-2 focus-within:ring-[var(--color-accent)] ${
        dragging ? '' : 'active:cursor-grabbing'
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-2xs text-[var(--color-text-faint)]">
        <span className="font-mono">{task.identifier}</span>
        {assignee && (
          <span className="ml-auto">
            <Avatar id={assignee.id} name={assignee.display_name} size={16} />
          </span>
        )}
      </div>
      <div className="flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0">
          <PriorityIcon p={task.priority} size={13} />
        </span>
        <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-[var(--color-text)]">
          {task.title}
        </span>
      </div>
      {(labels.length > 0 || task.due_date || task.comment_count > 0 || task.sub_count > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
          {task.due_date && <DueBadge due={task.due_date} />}
          {task.sub_count > 0 && (
            <span className="flex items-center gap-1 text-2xs text-[var(--color-text-faint)]"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 3v12a3 3 0 1 0 3 3" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>{task.sub_count}</span>
          )}
          {task.comment_count > 0 && (
            <span className="flex items-center gap-1 text-2xs text-[var(--color-text-faint)]"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M20 15a4 4 0 0 1-4 4H9l-5 3v-7a4 4 0 0 1-2-3.5V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" /></svg>{task.comment_count}</span>
          )}
          {project.id !== task.project_id && null}
        </div>
      )}
    </div>
  )
}
