// "Create task…" from a chat message: pick a project (skipped when there is
// exactly one), then the standard NewTaskModal prefilled from the message and
// bound back to it via source_message_id.
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../../store'
import type { Message, Project } from '../../lib/types'
import { Modal } from '../Modal'
import { NewTaskModal } from './NewTaskModal'

export function CreateTaskFromMessage({
  message,
  onClose,
}: {
  message: Message
  onClose: () => void
}) {
  const projects = useStore((s) => s.projects)
  const navigate = useNavigate()
  const active = useMemo(() => projects.filter((p) => !p.archived_at), [projects])
  const [project, setProject] = useState<Project | null>(active.length === 1 ? active[0] : null)

  const content = (message.decryptedText ?? message.content).trim()
  const firstLine = content.split('\n')[0].slice(0, 200)
  const description = content.length > firstLine.length ? `> ${content.replace(/\n/g, '\n> ')}` : ''

  if (active.length === 0) {
    return (
      <Modal title="Create task" onClose={onClose}>
        <p className="text-sm text-[var(--color-text-dim)]">
          No projects yet. Create one in the Tasks area first.
        </p>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => {
              onClose()
              navigate('/tasks')
            }}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-white"
          >
            Open Tasks
          </button>
        </div>
      </Modal>
    )
  }

  if (!project) {
    return (
      <Modal title="Create task in…" onClose={onClose}>
        <div className="space-y-1">
          {active.map((p) => (
            <button
              key={p.id}
              onClick={() => setProject(p)}
              className="flex w-full items-center gap-2.5 rounded-lg border border-[var(--color-border)] px-3 py-2 text-left hover:border-[var(--color-accent)] hover:bg-[var(--color-panel-2)]"
            >
              <span className="text-lg">{p.icon || '🎯'}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
              <span className="font-mono text-[11px] text-[var(--color-text-faint)]">{p.key}</span>
            </button>
          ))}
        </div>
      </Modal>
    )
  }

  return (
    <NewTaskModal
      project={project}
      initialTitle={firstLine}
      initialDescription={description}
      sourceMessageId={message.id}
      onClose={onClose}
      onCreated={(task) =>
        navigate(`/t/${project.key.toLowerCase()}/${task.number}`)
      }
    />
  )
}
