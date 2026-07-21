// /t/:key — one project: filter bar, list/board toggle, `c` to create, and the
// task peek when the route carries a number (/t/:key/:num).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import type { Task, TaskPriority } from '../../lib/types'
import { NewTaskModal } from './NewTaskModal'
import { TaskBoardView } from './TaskBoardView'
import { TaskListView } from './TaskListView'
import { TaskPeek } from './TaskPeek'
import { PRIORITIES, PRIORITY_LABELS, PriorityIcon, StateDot, isOpen, stateOf } from './taskUi'
import { Avatar } from '../Avatar'

const VIEW_KEY = 'sharp.taskView.' // + projectId → 'list' | 'board'

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.closest('input, textarea, select, [contenteditable="true"]') !== null)
  )
}

export function ProjectView() {
  const { key, num } = useParams()
  const navigate = useNavigate()
  const projects = useStore((s) => s.projects)
  const tasksByProject = useStore((s) => s.tasksByProject)
  const loadProjectTasks = useStore((s) => s.loadProjectTasks)
  const setActiveProject = useStore((s) => s.setActiveProject)
  const users = useStore((s) => s.users)

  const project = projects.find((p) => p.key === (key ?? '').toUpperCase())

  const [view, setView] = useState<'list' | 'board'>('list')
  const [newTask, setNewTask] = useState<{ stateId?: string } | null>(null)
  const [filterState, setFilterState] = useState<string | null>(null)
  const [filterAssignee, setFilterAssignee] = useState<string | null>(null)
  const [filterPriority, setFilterPriority] = useState<TaskPriority | null>(null)
  const [showClosed, setShowClosed] = useState(false)

  useEffect(() => {
    if (!project) return
    setActiveProject(project.id)
    void loadProjectTasks(project.id)
    setView(
      (window.localStorage.getItem(VIEW_KEY + project.id) as 'list' | 'board') ?? 'list',
    )
    return () => setActiveProject(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  function switchView(v: 'list' | 'board') {
    setView(v)
    if (project) window.localStorage.setItem(VIEW_KEY + project.id, v)
  }

  // `c` creates a task from anywhere in the project view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.key === 'c' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target) &&
        !newTask &&
        !num
      ) {
        e.preventDefault()
        setNewTask({})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newTask, num])

  const allTasks = project ? (tasksByProject[project.id] ?? []) : []

  const tasks = useMemo(() => {
    return allTasks.filter((t) => {
      const st = stateOf(project, t)
      if (!showClosed && !isOpen(st) && !filterState) return false
      if (filterState && t.state_id !== filterState) return false
      if (filterAssignee && t.assignee_id !== filterAssignee) return false
      if (filterPriority !== null && t.priority !== filterPriority) return false
      return true
    })
  }, [allTasks, project, filterState, filterAssignee, filterPriority, showClosed])

  // Peek task from the /t/:key/:num route.
  const peekTask = useMemo(
    () => (num ? allTasks.find((t) => t.number === Number(num)) : undefined),
    [allTasks, num],
  )
  const [peekId, setPeekId] = useState<string | null>(null)
  useEffect(() => {
    if (!num) {
      setPeekId(null)
      return
    }
    if (peekTask) {
      setPeekId(peekTask.id)
      return
    }
    // Deep link before the list is loaded: resolve via by-key.
    if (project) {
      import('../../lib/api').then(({ api }) =>
        api.tasks
          .byKey(`${project.key}-${num}`)
          .then((t) => setPeekId(t.id))
          .catch(() => navigate(`/t/${project.key.toLowerCase()}`, { replace: true })),
      )
    }
  }, [num, peekTask, project, navigate])

  if (!project) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-faint)]">
        {projects.length === 0 ? 'Loading…' : 'Project not found.'}
      </div>
    )
  }

  const openTask = (task: Task) =>
    navigate(`/t/${project.key.toLowerCase()}/${task.number}`)
  const closePeek = () => navigate(`/t/${project.key.toLowerCase()}`)

  const assigneesInProject = [
    ...new Set(allTasks.map((t) => t.assignee_id).filter((id): id is string => !!id)),
  ]

  return (
    <div className="relative flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-5">
        <span className="text-lg">{project.icon || '🎯'}</span>
        <span className="min-w-0 truncate font-semibold">{project.name}</span>
        <span className="font-mono text-xs text-[var(--color-text-faint)]">{project.key}</span>

        <div className="ml-auto flex items-center gap-2">
          {/* filters */}
          <FilterChip
            label="State"
            active={!!filterState}
            onClear={() => setFilterState(null)}
            options={project.states.map((s) => ({
              id: s.id,
              label: s.name,
              icon: <StateDot state={s} size={10} />,
            }))}
            onPick={setFilterState}
            current={filterState}
          />
          <FilterChip
            label="Assignee"
            active={!!filterAssignee}
            onClear={() => setFilterAssignee(null)}
            options={assigneesInProject.map((id) => ({
              id,
              label: users[id]?.display_name ?? '…',
              icon: <Avatar id={id} name={users[id]?.display_name ?? '?'} size={14} />,
            }))}
            onPick={setFilterAssignee}
            current={filterAssignee}
          />
          <FilterChip
            label="Priority"
            active={filterPriority !== null}
            onClear={() => setFilterPriority(null)}
            options={PRIORITIES.map((p) => ({
              id: String(p),
              label: PRIORITY_LABELS[p],
              icon: <PriorityIcon p={p} size={12} />,
            }))}
            onPick={(id) => setFilterPriority(Number(id) as TaskPriority)}
            current={filterPriority !== null ? String(filterPriority) : null}
          />
          <button
            onClick={() => setShowClosed((v) => !v)}
            className={`rounded-md px-2 py-1 text-xs ${
              showClosed
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
                : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)]'
            }`}
          >
            Closed
          </button>

          {/* view toggle */}
          <div className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
            <ViewToggle active={view === 'list'} onClick={() => switchView('list')} title="List view">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </ViewToggle>
            <ViewToggle active={view === 'board'} onClick={() => switchView('board')} title="Board view">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="4" y="4" width="4" height="16" rx="1" />
                <rect x="10" y="4" width="4" height="11" rx="1" />
                <rect x="16" y="4" width="4" height="7" rx="1" />
              </svg>
            </ViewToggle>
          </div>

          <button
            onClick={() => setNewTask({})}
            title="New task (c)"
            className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-2.5 py-1.5 text-sm font-semibold text-white hover:opacity-90"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            New
          </button>
        </div>
      </header>

      {view === 'board' ? (
        <TaskBoardView
          project={project}
          tasks={tasks}
          onOpenTask={openTask}
          onNewTask={(stateId) => setNewTask({ stateId })}
        />
      ) : (
        <TaskListView
          project={project}
          tasks={tasks}
          onOpenTask={openTask}
          onNewTask={(stateId) => setNewTask({ stateId })}
        />
      )}

      {newTask && (
        <NewTaskModal
          project={project}
          initialStateId={newTask.stateId}
          onClose={() => setNewTask(null)}
          onCreated={openTask}
        />
      )}

      {num && peekId && (
        <TaskPeek project={project} taskId={peekId} onClose={closePeek} onOpenTask={openTask} />
      )}
    </div>
  )
}

function ViewToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-7 w-8 items-center justify-center ${
        active
          ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
          : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)] hover:text-[var(--color-text)]'
      }`}
    >
      {children}
    </button>
  )
}

function FilterChip({
  label,
  active,
  current,
  options,
  onPick,
  onClear,
}: {
  label: string
  active: boolean
  current: string | null
  options: Array<{ id: string; label: string; icon?: React.ReactNode }>
  onPick: (id: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const currentLabel = options.find((o) => o.id === current)?.label
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
          active
            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]'
            : 'text-[var(--color-text-faint)] hover:bg-[var(--color-panel)]'
        }`}
      >
        {active ? currentLabel : label}
        {active && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onClear()
            }}
            className="hover:text-[var(--color-text)]"
          >
            ✕
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-40 mt-1 w-48 rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
            {options.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-[var(--color-text-faint)]">Nothing here</div>
            )}
            {options.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  onPick(o.id)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-panel-2)] ${
                  o.id === current ? 'text-[var(--color-accent-hover)]' : 'text-[var(--color-text)]'
                }`}
              >
                {o.icon && <span className="flex w-4 justify-center">{o.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
