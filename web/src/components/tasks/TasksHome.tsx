// /tasks — My Issues (open tasks assigned to me, grouped by project) plus the
// project grid and the create-project flow.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { useStore } from '../../store'
import type { Project } from '../../lib/types'
import { Modal } from '../Modal'
import { TaskRow } from './TaskListView'

export function TasksHome() {
  const projects = useStore((s) => s.projects)
  const myTasks = useStore((s) => s.myTasks)
  const loadProjects = useStore((s) => s.loadProjects)
  const loadMyTasks = useStore((s) => s.loadMyTasks)
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void loadProjects()
    void loadMyTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const active = useMemo(() => projects.filter((p) => !p.archived_at), [projects])
  const byProject = useMemo(() => {
    const groups = new Map<string, typeof myTasks>()
    for (const t of myTasks) {
      const list = groups.get(t.project_id) ?? []
      list.push(t)
      groups.set(t.project_id, list)
    }
    return groups
  }, [myTasks])

  const projectOf = (id: string): Project | undefined => projects.find((p) => p.id === id)

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-[var(--color-ink)]">
      <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-5">
        <span className="font-semibold">Tasks</span>
        <span className="text-sm text-[var(--color-text-dim)]">Plan and track work</span>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-2.5 py-1.5 text-sm font-semibold text-white hover:opacity-90"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          New project
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_20rem]">
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                My issues
              </h2>
              {myTasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
                  <div className="mb-2 text-3xl">🎯</div>
                  <p className="text-sm text-[var(--color-text-dim)]">
                    Nothing assigned to you.
                    {active.length === 0 && ' Create a project to get started.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {[...byProject.entries()].map(([projectId, tasks]) => {
                    const project = projectOf(projectId)
                    if (!project) return null
                    return (
                      <div key={projectId}>
                        <button
                          onClick={() => navigate(`/t/${project.key.toLowerCase()}`)}
                          className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-[var(--color-text-dim)] hover:text-[var(--color-text)]"
                        >
                          <span>{project.icon || '🎯'}</span>
                          <span>{project.name}</span>
                        </button>
                        <div className="overflow-hidden rounded-xl border border-[var(--color-border)]">
                          {tasks.map((task) => (
                            <TaskRow
                              key={task.id}
                              task={task}
                              onOpen={(t) =>
                                navigate(`/t/${project.key.toLowerCase()}/${t.number}`)
                              }
                            />
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
                Projects
              </h2>
              {active.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
                  No projects yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {active.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/t/${p.key.toLowerCase()}`)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel)] px-3 py-2.5 text-left transition hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)]"
                    >
                      <span className="text-lg">{p.icon || '🎯'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{p.name}</div>
                        <div className="font-mono text-[11px] text-[var(--color-text-faint)]">
                          {p.key}
                        </div>
                      </div>
                      <span className="text-xs text-[var(--color-text-faint)]">
                        {p.open_count} open
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewProjectModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [icon, setIcon] = useState('')
  const [busy, setBusy] = useState(false)

  function suggestKey(fromName: string): string {
    const words = fromName
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
    if (words.length === 0) return ''
    const first = words[0]
    return (words.length === 1 ? first.slice(0, 5) : words.map((w) => w[0]).join('').slice(0, 6))
      .replace(/^[0-9]+/, '')
      .slice(0, 6)
  }

  async function submit() {
    if (!name.trim() || !key.trim() || busy) return
    setBusy(true)
    try {
      const project = await api.tasks.createProject({
        name: name.trim(),
        key: key.trim().toUpperCase(),
        icon: icon.trim() || undefined,
      })
      onClose()
      navigate(`/t/${project.key.toLowerCase()}`)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-[var(--color-text-dim)]">
            Name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!keyTouched) setKey(suggestKey(e.target.value))
            }}
            placeholder="Website redesign"
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-dim)]">
              Key <span className="text-[var(--color-text-faint)]">(prefixes ids: KEY-123)</span>
            </label>
            <input
              value={key}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))
              }}
              placeholder="WEB"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 font-mono text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
          <div className="w-24">
            <label className="mb-1 block text-xs font-medium text-[var(--color-text-dim)]">
              Icon
            </label>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="🎯"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-center text-sm focus:border-[var(--color-accent)] focus:outline-none"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!name.trim() || key.trim().length < 2 || busy}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            Create project
          </button>
        </div>
      </div>
    </Modal>
  )
}
