// /t/:key — one project: filter bar, list/board toggle, `c` to create, and the
// task peek when the route carries a number (/t/:key/:num).
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../../store'
import { registerShortcut } from '../../lib/shortcuts'
import { KEY_PREFIXES, readLocal, scopedKey, writeLocal } from '../../lib/localPrefs'
import type { Task, TaskPriority } from '../../lib/types'
import { NewTaskModal } from './NewTaskModal'
import { TaskBoardView } from './TaskBoardView'
import { TaskListView } from './TaskListView'
import { TaskPeek } from './TaskPeek'
import { PRIORITIES, PRIORITY_LABELS, PriorityIcon, StateDot } from './taskUi'
import { Avatar } from '../Avatar'
import { Button, CheckIcon, ChevronLeftIcon, IconButton, Menu, MenuItem, PlusIcon } from '../../ui'


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

  useEffect(() => {
    if (!project) return
    setActiveProject(project.id)
    void loadProjectTasks(project.id)
    setView(
      (readLocal(scopedKey(KEY_PREFIXES.taskView, project.id)) as 'list' | 'board') ?? 'list',
    )
    return () => setActiveProject(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  function switchView(v: 'list' | 'board') {
    setView(v)
    if (project) writeLocal(scopedKey(KEY_PREFIXES.taskView, project.id), v)
  }

  // `c` creates a task from anywhere in the project view.
  useEffect(() => {
    // Not while a task is already being created or a peek is open.
    return registerShortcut('task.create', (e) => {
      if (newTask || num) return
      e.preventDefault()
      setNewTask({})
    })
  }, [newTask, num])

  const allTasks = project ? (tasksByProject[project.id] ?? []) : []

  const tasks = useMemo(() => {
    return allTasks.filter((t) => {
      if (filterState && t.state_id !== filterState) return false
      if (filterAssignee && t.assignee_id !== filterAssignee) return false
      if (filterPriority !== null && t.priority !== filterPriority) return false
      return true
    })
  }, [allTasks, project, filterState, filterAssignee, filterPriority])

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
      <header className="shrink-0">
        <div className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-3 sm:px-5">
          <IconButton size="xl" label="Back to Tasks" onClick={() => navigate('/tasks')} className="md:hidden"><ChevronLeftIcon size={18} /></IconButton>
          <div className="min-w-0 flex flex-1 items-center gap-2"><Button variant="ghost" size="sm" onClick={() => navigate('/tasks')} className="max-md:hidden min-h-11 font-normal text-text-faint">‹ Tasks</Button><span className="max-md:hidden text-[var(--color-text-faint)]">/</span><span className="shrink-0 text-lg">{project.icon || '🎯'}</span><span className="min-w-0 truncate font-semibold">{project.name}</span><span className="hidden font-mono text-xs text-[var(--color-text-faint)] sm:inline">{project.key}</span></div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-[var(--color-border)]">
              <ViewToggle active={view === 'list'} onClick={() => switchView('list')} title="List view"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 6h16M4 12h16M4 18h16" /></svg></ViewToggle>
              <ViewToggle active={view === 'board'} onClick={() => switchView('board')} title="Board view"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="4" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="11" rx="1" /><rect x="16" y="4" width="4" height="7" rx="1" /></svg></ViewToggle>
            </div>
            <Button size="md" className="min-h-11" onClick={() => setNewTask({})} title="New task (c)" aria-label="New task" iconLeft={<PlusIcon size={14} strokeWidth={2.5} />}><span className="hidden sm:inline">New task</span></Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-soft)] px-3 py-2 sm:px-5">
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
      aria-pressed={active}
      className={`flex h-9 w-10 cursor-pointer items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)] ${
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
    <div className="shrink-0">
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        align="start"
        width="w-52"
        className="max-h-72 overflow-y-auto"
        trigger={
          <span className="flex items-center">
            <button
              onClick={() => setOpen((o) => !o)}
              className={`flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] pr-8 text-[var(--color-accent-hover)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-faint)] hover:bg-[var(--color-panel)]'
              }`}
            >
              {active ? currentLabel : label}
            </button>
            {active && <button type="button" aria-label={`Clear ${label} filter`} onClick={onClear} className="-ml-7 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[var(--color-accent-hover)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="m6 6 12 12M18 6 6 18" /></svg></button>}
          </span>
        }
      >
        {options.length === 0 && (
          <div className="px-3 py-2 text-sm text-text-faint">Nothing here</div>
        )}
        {options.map((o) => (
          <MenuItem
            key={o.id}
            icon={o.icon && <span className="flex w-4 justify-center">{o.icon}</span>}
            trailing={o.id === current ? <CheckIcon size={14} className="text-accent" /> : undefined}
            className={o.id === current ? 'text-accent-hover' : undefined}
            onClick={() => {
              onPick(o.id)
              setOpen(false)
            }}
          >
            {o.label}
          </MenuItem>
        ))}
      </Menu>
    </div>
  )
}
