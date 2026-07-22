import { useNavigate } from 'react-router-dom'
import type { SharpySource } from '../../lib/types'

export function SharpyCitationChips({ sources }: { sources: SharpySource[] }) {
  const navigate = useNavigate()

  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map((src, index) => {
        const label =
          src.kind === 'message'
            ? `#${src.channel_name} · ${src.author}`
            : src.kind === 'task'
              ? `${src.identifier} ${src.title}`
              : src.title
        const taskAt = src.kind === 'task' ? src.identifier.lastIndexOf('-') : -1
        const to =
          src.kind === 'message'
            ? `/c/${src.channel_id}`
            : src.kind === 'task'
              ? `/t/${src.identifier.slice(0, taskAt).toLowerCase()}/${src.identifier.slice(taskAt + 1)}`
              : src.doc_kind === 'canvas'
                ? `/x/${src.doc_id}`
                : src.doc_kind === 'board'
                  ? `/b/${src.doc_id}`
                  : `/d/${src.doc_id}`
        const key =
          src.kind === 'message'
            ? `m-${src.message_id}-${index}`
            : src.kind === 'task'
              ? `t-${src.task_id}-${index}`
              : `d-${src.doc_id}-${index}`

        return (
          <button
            key={key}
            type="button"
            title={src.snippet}
            onClick={() => navigate(to)}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-panel)] px-2 py-1 text-[11px] text-[var(--color-text-dim)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <span className="text-[var(--color-text-faint)]">[{index + 1}]</span>
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
