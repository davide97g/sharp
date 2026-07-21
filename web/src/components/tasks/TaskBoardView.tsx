import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../store'
import type { Project, Task } from '../../lib/types'
import { Avatar } from '../Avatar'
import { colorOf } from '../../lib/boardColors'
import { DueBadge, LabelChip, PriorityIcon } from './taskUi'
import { useTaskDnd, type TaskColumnData } from './useTaskDnd'

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
    <div ref={scrollRef} className="flex flex-1 gap-3 overflow-x-auto px-5 pb-5 pt-4">
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
      className="flex max-h-full w-[300px] shrink-0 flex-col rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)]"
    >
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <span
          className="flex min-w-0 select-none items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold"
          style={{ backgroundColor: swatch.bg, color: swatch.fg }}
        >
          <span className="truncate">{column.state.name}</span>
        </span>
        <span className="text-xs text-[var(--color-text-faint)]">{column.tasks.length}</span>
        <button
          type="button"
          onClick={() => onNewTask(column.state.id)}
          aria-label={`New task in ${column.state.name}`}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
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
      onPointerDown={(e) => dnd.startDrag(e, task.id)}
      onClick={() => {
        if (!dnd.consumeSuppressClick()) onOpen(task)
      }}
      className={dragging ? 'opacity-30' : ''}
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
      className={`cursor-pointer select-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-2.5 transition hover:border-[var(--color-accent)] ${
        dragging ? '' : 'active:cursor-grabbing'
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-[var(--color-text-faint)]">
        <span className="font-mono">{task.identifier}</span>
        {assignee && (
          <span className="ml-auto">
            <Avatar id={assignee.id} name={assignee.display_name} size={16} />
          </span>
        )}
      </div>
      <div className="mb-1.5 flex items-start gap-1.5">
        <span className="mt-0.5 shrink-0">
          <PriorityIcon p={task.priority} size={13} />
        </span>
        <span className="min-w-0 flex-1 text-sm leading-snug text-[var(--color-text)]">
          {task.title}
        </span>
      </div>
      {(labels.length > 0 || task.due_date || task.comment_count > 0 || task.sub_count > 0) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {labels.map((l) => (
            <LabelChip key={l.id} label={l} />
          ))}
          {task.due_date && <DueBadge due={task.due_date} />}
          {task.sub_count > 0 && (
            <span className="text-[10px] text-[var(--color-text-faint)]">
              ⑃ {task.sub_count}
            </span>
          )}
          {task.comment_count > 0 && (
            <span className="text-[10px] text-[var(--color-text-faint)]">
              💬 {task.comment_count}
            </span>
          )}
          {project.id !== task.project_id && null}
        </div>
      )}
    </div>
  )
}
