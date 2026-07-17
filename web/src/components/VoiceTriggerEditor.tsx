import { useState } from 'react'
import type { VoiceTrigger } from '../lib/types'
import { toastError } from '../lib/toast'

export function VoiceTriggerEditor({
  triggers,
  loading,
  canEdit,
  hint,
  onAdd,
  onDelete,
}: {
  triggers: VoiceTrigger[]
  loading: boolean
  canEdit: boolean
  hint: string
  onAdd: (phrase: string) => Promise<void>
  onDelete: (triggerId: string) => Promise<void>
}) {
  const [phrase, setPhrase] = useState('')
  const [pending, setPending] = useState<string | null>(null)

  async function add() {
    const value = phrase.trim()
    if (!value || pending) return
    setPending('add')
    try {
      await onAdd(value)
      setPhrase('')
    } catch (error) {
      if (error instanceof Error) toastError(error.message)
    } finally {
      setPending(null)
    }
  }

  async function remove(triggerId: string) {
    if (pending) return
    setPending(triggerId)
    try {
      await onDelete(triggerId)
    } catch (error) {
      if (error instanceof Error) toastError(error.message)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
          Voice triggers
        </div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-faint)]">{hint}</p>
      </div>

      {canEdit && (
        <div className="flex gap-2">
          <input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void add()
              }
            }}
            maxLength={80}
            placeholder="Add a trigger phrase"
            className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={!phrase.trim() || pending !== null}
            className="rounded-lg bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {pending === 'add' ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          <div className="skeleton h-9 rounded-lg" />
          <div className="skeleton h-9 rounded-lg" />
        </div>
      ) : triggers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--color-border)] px-3 py-3 text-sm text-[var(--color-text-faint)]">
          No voice triggers yet.
        </div>
      ) : (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {triggers.map((trigger) => (
            <div
              key={trigger.id}
              className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-[var(--color-text)]">
                “{trigger.phrase}”
              </span>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void remove(trigger.id)}
                  disabled={pending !== null}
                  className="rounded-md px-2 py-1 text-xs text-[var(--color-text-faint)] hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                >
                  {pending === trigger.id ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
