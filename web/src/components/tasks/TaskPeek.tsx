// Linear-style peek: a slide-over with editable title/description, a property
// rail, GitHub links, sub-tasks, and an interleaved comment/activity feed.
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { useStore } from '../../store'
import { toastError, toastInfo } from '../../lib/toast'
import type { Project, Task, TaskActivity, TaskComment } from '../../lib/types'
import { Avatar } from '../Avatar'
import { Markdown } from '../Markdown'
import {
  AssigneePicker,
  DuePicker,
  LabelsPicker,
  PriorityPicker,
  StatePicker,
} from './PropertyPicker'
import { TaskRow } from './TaskListView'
import { branchNameFor, PRIORITY_LABELS } from './taskUi'

export function TaskPeek({
  project,
  taskId,
  onClose,
  onOpenTask,
}: {
  project: Project
  taskId: string
  onClose: () => void
  onOpenTask: (task: Task) => void
}) {
  const detail = useStore((s) => s.taskDetails[taskId])
  const loadTaskDetail = useStore((s) => s.loadTaskDetail)
  const patchTask = useStore((s) => s.patchTask)
  const me = useStore((s) => s.me)

  const [editingDescription, setEditingDescription] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const [comment, setComment] = useState('')
  const titleRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadTaskDetail(taskId).catch((e) => {
      if (e instanceof Error) toastError(e.message)
      onClose()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId])

  // Esc closes (unless typing in a field that handles it itself).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const feed = useMemo(() => {
    if (!detail) return []
    const entries: Array<
      { at: string } & ({ kind: 'comment'; comment: TaskComment } | { kind: 'activity'; activity: TaskActivity })
    > = []
    for (const c of detail.comments) entries.push({ at: c.created_at, kind: 'comment', comment: c })
    for (const a of detail.activity) {
      if (a.kind === 'created' || a.kind === 'description') continue
      entries.push({ at: a.created_at, kind: 'activity', activity: a })
    }
    return entries.sort((x, y) => (x.at < y.at ? -1 : 1))
  }, [detail])

  if (!detail) {
    return (
      <Shell onClose={onClose}>
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-faint)]">
          Loading…
        </div>
      </Shell>
    )
  }

  async function submitComment() {
    const body = comment.trim()
    if (!body) return
    setComment('')
    try {
      await api.tasks.comment(taskId, body)
      await loadTaskDetail(taskId)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${detail!.identifier}? This can't be undone from the UI.`)) return
    try {
      await api.tasks.delete(taskId)
      onClose()
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  }

  function copyBranch() {
    void navigator.clipboard.writeText(branchNameFor(detail!))
    toastInfo('Branch name copied')
  }

  return (
    <Shell onClose={onClose}>
      {/* header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
        <span className="font-mono text-xs text-[var(--color-text-faint)]">
          {detail.identifier}
        </span>
        <button
          onClick={copyBranch}
          title="Copy git branch name"
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 3v12a3 3 0 1 0 3 3" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          Copy branch
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={remove}
            title="Delete task"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--board-red-fg)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 pt-3">
          {/* title, edit-in-place */}
          <textarea
            ref={titleRef}
            defaultValue={detail.title}
            rows={1}
            onBlur={(e) => {
              const title = e.target.value.trim()
              if (title && title !== detail.title) void patchTask(taskId, { title })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                ;(e.target as HTMLTextAreaElement).blur()
              }
            }}
            onInput={(e) => {
              const el = e.target as HTMLTextAreaElement
              el.style.height = 'auto'
              el.style.height = `${el.scrollHeight}px`
            }}
            className="w-full resize-none bg-transparent text-lg font-semibold leading-snug text-[var(--color-text)] focus:outline-none"
          />

          {/* property rail */}
          <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
            <StatePicker
              project={project}
              stateId={detail.state_id}
              onPick={(state_id) => void patchTask(taskId, { state_id })}
            />
            <PriorityPicker
              priority={detail.priority}
              onPick={(priority) => void patchTask(taskId, { priority })}
            />
            <AssigneePicker
              assigneeId={detail.assignee_id}
              onPick={(assignee_id) => void patchTask(taskId, { assignee_id })}
            />
            <LabelsPicker
              labelIds={detail.label_ids}
              onChange={(label_ids) => void patchTask(taskId, { label_ids })}
            />
            <DuePicker
              due={detail.due_date}
              onPick={(due_date) => void patchTask(taskId, { due_date })}
            />
          </div>

          {/* description */}
          <div className="mt-3">
            {editingDescription ? (
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={() => {
                  setEditingDescription(false)
                  if (descDraft !== detail.description)
                    void patchTask(taskId, { description: descDraft })
                }}
                rows={Math.min(16, Math.max(4, descDraft.split('\n').length + 1))}
                placeholder="Add a description… (markdown)"
                className="w-full resize-y rounded-lg border border-[var(--color-accent)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:outline-none"
              />
            ) : (
              <div
                onClick={() => {
                  setDescDraft(detail.description)
                  setEditingDescription(true)
                }}
                className="min-h-10 cursor-text rounded-lg px-1 py-1 text-sm hover:bg-[var(--color-panel)]"
              >
                {detail.description ? (
                  <Markdown content={detail.description} />
                ) : (
                  <span className="text-[var(--color-text-faint)]">Add a description…</span>
                )}
              </div>
            )}
          </div>

          {/* github links */}
          {detail.github_links.length > 0 && (
            <div className="mt-3">
              <SectionLabel>GitHub</SectionLabel>
              <div className="space-y-1">
                {detail.github_links.map((link) => (
                  <a
                    key={link.id}
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-sm text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]"
                  >
                    <GithubLinkBadge state={link.state} kind={link.kind} />
                    <span className="min-w-0 flex-1 truncate">
                      {link.title || link.ref}
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--color-text-faint)]">
                      {link.repo}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* sub-tasks */}
          {detail.sub_tasks.length > 0 && (
            <div className="mt-3">
              <SectionLabel>Sub-tasks</SectionLabel>
              <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
                {detail.sub_tasks.map((sub) => (
                  <TaskRow key={sub.id} task={sub} onOpen={onOpenTask} showIdentifier={false} />
                ))}
              </div>
            </div>
          )}

          {/* feed */}
          <div className="mt-4 border-t border-[var(--color-border)] pt-3">
            <SectionLabel>Activity</SectionLabel>
            <div className="space-y-2.5 pb-3">
              {feed.map((entry, i) =>
                entry.kind === 'comment' ? (
                  <CommentItem
                    key={`c-${entry.comment.id}`}
                    comment={entry.comment}
                    mine={entry.comment.author.id === me?.id}
                    onChanged={() => void loadTaskDetail(taskId)}
                  />
                ) : (
                  <ActivityItem key={`a-${i}`} activity={entry.activity} project={project} />
                ),
              )}
              {feed.length === 0 && (
                <div className="text-xs text-[var(--color-text-faint)]">No activity yet.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* comment composer */}
      <div className="border-t border-[var(--color-border)] p-3">
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submitComment()
            }
          }}
          rows={2}
          placeholder="Leave a comment…"
          className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>
    </Shell>
  )
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/30" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-[var(--color-border)] bg-[var(--color-ink)] shadow-2xl">
        {children}
      </aside>
    </>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
      {children}
    </div>
  )
}

function GithubLinkBadge({ state, kind }: { state: string; kind: string }) {
  const color =
    state === 'merged'
      ? 'var(--board-purple-fg)'
      : state === 'closed'
        ? 'var(--board-red-fg)'
        : state === 'draft'
          ? 'var(--color-text-faint)'
          : 'var(--board-green-fg)'
  return (
    <span
      className="rounded-full px-1.5 py-px text-[10px] font-semibold"
      style={{ color, border: `1px solid ${color}` }}
    >
      {kind === 'branch' ? 'branch' : state || kind}
    </span>
  )
}

function CommentItem({
  comment,
  mine,
  onChanged,
}: {
  comment: TaskComment
  mine: boolean
  onChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  if (comment.deleted) {
    return (
      <div className="text-xs italic text-[var(--color-text-faint)]">Comment deleted</div>
    )
  }
  return (
    <div className="flex items-start gap-2">
      <Avatar id={comment.author.id} name={comment.author.display_name} size={22} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold">{comment.author.display_name}</span>
          <span className="text-[10px] text-[var(--color-text-faint)]">
            {new Date(comment.created_at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {comment.updated_at ? ' · edited' : ''}
          </span>
          {mine && !editing && (
            <span className="ml-auto flex gap-1">
              <button
                onClick={() => {
                  setDraft(comment.body)
                  setEditing(true)
                }}
                className="text-[10px] text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
              >
                Edit
              </button>
              <button
                onClick={async () => {
                  try {
                    await api.tasks.deleteComment(comment.id)
                    onChanged()
                  } catch (e) {
                    if (e instanceof Error) toastError(e.message)
                  }
                }}
                className="text-[10px] text-[var(--color-text-faint)] hover:text-[var(--board-red-fg)]"
              >
                Delete
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                try {
                  await api.tasks.updateComment(comment.id, draft.trim())
                  setEditing(false)
                  onChanged()
                } catch (err) {
                  if (err instanceof Error) toastError(err.message)
                }
              } else if (e.key === 'Escape') {
                setEditing(false)
              }
            }}
            rows={2}
            className="mt-1 w-full resize-none rounded-md border border-[var(--color-accent)] bg-[var(--color-panel-2)] px-2 py-1 text-sm focus:outline-none"
          />
        ) : (
          <div className="text-sm">
            <Markdown content={comment.body} />
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityItem({ activity, project }: { activity: TaskActivity; project: Project }) {
  const users = useStore((s) => s.users)
  const taskLabels = useStore((s) => s.taskLabels)
  const who = activity.actor?.display_name ?? 'GitHub'

  function stateName(id: unknown): string {
    return project.states.find((s) => s.id === id)?.name ?? 'unknown'
  }
  function userName(id: unknown): string {
    if (!id || typeof id !== 'string') return 'nobody'
    return users[id]?.display_name ?? 'someone'
  }

  const p = activity.payload
  let text: string
  switch (activity.kind) {
    case 'state':
      text = `moved to ${stateName(p.to)}`
      break
    case 'assignee':
      text = p.to ? `assigned ${userName(p.to)}` : 'removed the assignee'
      break
    case 'priority':
      text = `set priority to ${PRIORITY_LABELS[(p.to as 0 | 1 | 2 | 3 | 4) ?? 0]}`
      break
    case 'labels': {
      const to = Array.isArray(p.to) ? (p.to as string[]) : []
      const names = taskLabels.filter((l) => to.includes(l.id)).map((l) => l.name)
      text = names.length ? `set labels: ${names.join(', ')}` : 'cleared labels'
      break
    }
    case 'due':
      text = p.to ? `set due date to ${String(p.to)}` : 'cleared the due date'
      break
    case 'title':
      text = `renamed the task`
      break
    case 'github_link':
      text = `linked ${String(p.kind ?? 'a branch')} ${String(p.ref ?? '')}`.trim()
      break
    default:
      text = activity.kind
  }

  return (
    <div className="flex items-center gap-2 text-xs text-[var(--color-text-faint)]">
      <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--color-border)]" />
      <span>
        <span className="text-[var(--color-text-dim)]">{who}</span> {text}
      </span>
      <span className="ml-auto shrink-0 text-[10px]">
        {new Date(activity.created_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        })}
      </span>
    </div>
  )
}
