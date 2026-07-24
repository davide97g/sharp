import { useState } from 'react'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { useStore } from '../../store'
import type { Project, Task, TaskPriority } from '../../lib/types'
import { Modal } from '../Modal'
import { Button, Textarea } from '../../ui'
import {
  AssigneePicker,
  DuePicker,
  LabelsPicker,
  PriorityPicker,
  StatePicker,
} from './PropertyPicker'

export function NewTaskModal({
  project,
  initialStateId,
  sourceMessageId,
  initialTitle = '',
  initialDescription = '',
  onClose,
  onCreated,
}: {
  project: Project
  initialStateId?: string
  sourceMessageId?: string
  initialTitle?: string
  initialDescription?: string
  onClose: () => void
  onCreated?: (task: Task) => void
}) {
  const me = useStore((s) => s.me)
  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [stateId, setStateId] = useState(
    initialStateId ??
      project.states.find((s) => s.type === 'unstarted')?.id ??
      project.states[0]?.id ??
      '',
  )
  const [priority, setPriority] = useState<TaskPriority>(0)
  const [assigneeId, setAssigneeId] = useState<string | null>(null)
  const [labelIds, setLabelIds] = useState<string[]>([])
  const [due, setDue] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      const task = await api.tasks.create(project.id, {
        title: trimmed,
        description: description.trim() || undefined,
        state_id: stateId || undefined,
        priority,
        assignee_id: assigneeId ?? undefined,
        label_ids: labelIds.length ? labelIds : undefined,
        due_date: due ?? undefined,
        source_message_id: sourceMessageId,
      })
      onCreated?.(task)
      onClose()
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      setBusy(false)
    }
  }

  return (
    <Modal title={`New task · ${project.key}`} onClose={onClose} wide>
      <div className="space-y-3">
        {/* TODO(ds): Input — kept custom for the text-base font-medium title
            emphasis (ui Input chrome is text-sm only). */}
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          placeholder="Task title"
          className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-base font-medium text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        />
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          }}
          rows={4}
          placeholder="Description… (markdown)"
        />
        <div className="flex flex-wrap items-center gap-1">
          <StatePicker project={project} stateId={stateId} onPick={setStateId} />
          <PriorityPicker priority={priority} onPick={setPriority} />
          <AssigneePicker assigneeId={assigneeId} onPick={setAssigneeId} />
          <LabelsPicker labelIds={labelIds} onChange={setLabelIds} />
          <DuePicker due={due} onPick={setDue} />
        </div>
        <div className="flex items-center justify-between">
          {me && assigneeId === null && (
            <button
              onClick={() => setAssigneeId(me.id)}
              className="text-xs text-[var(--color-text-faint)] hover:text-[var(--color-accent-hover)]"
            >
              Assign to me
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" className="min-h-11" onClick={onClose}>
              Cancel
            </Button>
            <Button className="min-h-11" onClick={() => void submit()} disabled={!title.trim() || busy}>
              Create task
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
