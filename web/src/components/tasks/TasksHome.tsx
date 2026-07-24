// /tasks — My Issues (open tasks assigned to me, grouped by project) plus the
// project grid and the create-project flow.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { useStore } from '../../store'
import type { Project } from '../../lib/types'
import { Modal } from '../Modal'
import { TaskRow } from './TaskListView'
import { isOpen, stateOf, TasksGlyph } from './taskUi'
import { Button, Card, EmptyState, Field, Input, ModalFooter, SectionLabel } from '../../ui'

export function TasksHome() {
  const [params, setParams] = useSearchParams()
  const projects = useStore((s) => s.projects)
  const myTasks = useStore((s) => s.myTasks)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadMyTasks = useStore((s) => s.loadMyTasks)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [searchedTasks, setSearchedTasks] = useState<typeof myTasks | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    void loadProjects()
    void loadMyTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!query.trim()) { setSearchedTasks(null); return }
    const timer = window.setTimeout(() => {
      void api.tasks.search(query.trim(), 100).then((result) => setSearchedTasks(result.tasks)).catch(() => setSearchedTasks([]))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query])

  const active = useMemo(() => projects.filter((p) => !p.archived_at), [projects])
  const projectOf = (id: string): Project | undefined => projects.find((p) => p.id === id)
  const setQueryParam = (value: string) => { setQuery(value); const next = new URLSearchParams(params); value ? next.set('q', value) : next.delete('q'); setParams(next, { replace: true }) }
  const matchingTasks = useMemo(() => searchedTasks ?? myTasks, [searchedTasks, myTasks])
  const visibleTasks = useMemo(
    () => showAll ? matchingTasks : matchingTasks.filter((task) => isOpen(stateOf(projectOf(task.project_id), task))),
    [matchingTasks, showAll, projects],
  )
  const visibleGroups = useMemo(() => { const groups = new Map<string, typeof visibleTasks>(); for (const task of visibleTasks) { const list = groups.get(task.project_id) ?? []; list.push(task); groups.set(task.project_id, list) } return groups }, [visibleTasks])
  const openCount = myTasks.filter((task) => isOpen(stateOf(projectOf(task.project_id), task))).length

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl px-4 py-7 sm:px-6 sm:py-10">
          <header className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1"><h1 className="text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">Tasks</h1><p className="mt-1 text-sm text-[var(--color-text-faint)]">{openCount} open assigned to you · {active.length} projects</p></div>
            <Button
              className="ml-auto min-h-11"
              onClick={() => setCreating(true)}
              iconLeft={<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>}
            >
              New project
            </Button>
          </header>
          <div className="mt-6 flex flex-wrap gap-2">
            <label className="relative min-w-[min(100%,20rem)] flex-1"><svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-faint)]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input autoFocus value={query} onChange={(event) => setQueryParam(event.target.value)} placeholder="Search tasks…" className="min-h-11 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-panel)] pl-10 pr-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]" /></label>
            <FilterPill active={!showAll} onClick={() => setShowAll(false)}>Open</FilterPill>
            <FilterPill active={showAll} onClick={() => setShowAll(true)}>All</FilterPill>
          </div>

          <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <section>
              <SectionLabel as="h2" size="xs" className="mb-3">My issues</SectionLabel>
              {visibleTasks.length === 0 ? <TasksEmpty message={query ? 'No matching tasks.' : 'Nothing assigned to you.'} action={active.length === 0 ? () => setCreating(true) : undefined} /> : <div className="space-y-4">{[...visibleGroups.entries()].map(([projectId, tasks]) => {
                const project = projectOf(projectId)
                if (!project) return null
                return <div key={projectId}><button onClick={() => navigate(`/t/${project.key.toLowerCase()}`)} className="mb-1 flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md px-1 text-sm font-semibold text-[var(--color-text-dim)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"><span>{project.icon || '🎯'}</span><span>{project.name}</span></button><div className="overflow-hidden rounded-xl border border-[var(--color-border)]">{tasks.map((task) => <TaskRow key={task.id} task={task} onOpen={(t) => navigate(`/t/${project.key.toLowerCase()}/${t.number}`)} />)}</div></div>
              })}</div>}
            </section>
            <section>
              <SectionLabel as="h2" size="xs" className="mb-3">Projects</SectionLabel>
              {active.length === 0 ? <TasksEmpty message="No projects yet." action={() => setCreating(true)} /> : <div className="space-y-2">{active.map((p) => <Card key={p.id} as="button" interactive onClick={() => navigate(`/t/${p.key.toLowerCase()}`)} className="flex w-full items-center gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-soft)] text-lg text-[var(--color-accent-hover)]">{p.icon || '🎯'}</span><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{p.name}</div><div className="font-mono text-2xs text-[var(--color-text-faint)]">{p.key}</div></div><span className="shrink-0 text-xs text-[var(--color-text-faint)]">{p.open_count} open</span></Card>)}</div>}
            </section>
          </div>
        </div>
      </div>
      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  )
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) { return <button onClick={onClick} className={`min-h-11 cursor-pointer rounded-full border px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${active ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel)]'}`}>{children}</button> }
function TasksEmpty({ message, action }: { message: string; action?: () => void }) {
  return (
    <EmptyState
      variant="dashed"
      icon={<TasksGlyph size={28} />}
      title={message}
      action={action && <Button className="min-h-11" onClick={action}>Create your first project</Button>}
    />
  )
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate(); const [name, setName] = useState(''); const [key, setKey] = useState(''); const [keyTouched, setKeyTouched] = useState(false); const [icon, setIcon] = useState(''); const [busy, setBusy] = useState(false)
  function suggestKey(fromName: string): string { const words = fromName.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean); if (!words.length) return ''; const first = words[0]; return (words.length === 1 ? first.slice(0, 5) : words.map((word) => word[0]).join('').slice(0, 6)).replace(/^[0-9]+/, '').slice(0, 6) }
  async function submit() { if (!name.trim() || !key.trim() || busy) return; setBusy(true); try { const project = await api.tasks.createProject({ name: name.trim(), key: key.trim().toUpperCase(), icon: icon.trim() || undefined }); onClose(); navigate(`/t/${project.key.toLowerCase()}`) } catch (e) { if (e instanceof Error) toastError(e.message); setBusy(false) } }
  return (
    <Modal title="New project" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => { setName(e.target.value); if (!keyTouched) setKey(suggestKey(e.target.value)) }} placeholder="Website redesign" className="min-h-11" />
        </Field>
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label={<>Key <span className="text-[var(--color-text-faint)]">(prefixes ids: KEY-123)</span></>}>
              <Input value={key} onChange={(e) => { setKeyTouched(true); setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)) }} placeholder="WEB" className="min-h-11 font-mono" />
            </Field>
          </div>
          <div className="w-24">
            <Field label="Icon">
              <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="🎯" className="min-h-11 text-center" />
            </Field>
          </div>
        </div>
        <ModalFooter>
          <Button variant="ghost" className="min-h-11" onClick={onClose}>Cancel</Button>
          <Button className="min-h-11" onClick={() => void submit()} disabled={!name.trim() || key.trim().length < 2 || busy}>Create project</Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
