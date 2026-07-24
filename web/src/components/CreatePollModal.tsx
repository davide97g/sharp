import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { toastError } from '../lib/toast'
import { useStore } from '../store'
import { Button } from '../ui'
import { Modal } from './Modal'

type Mode = 'channel' | 'call'
type Preset = 'yes_no' | 'thumbs' | undefined

export function CreatePollModal({
  mode,
  channelId,
  onClose,
}: {
  mode: Mode
  channelId?: string
  onClose: () => void
}) {
  const createPoll = useStore((s) => s.createPoll)
  const createCallPoll = useStore((s) => s.createCallPoll)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [multi, setMulti] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [preset, setPreset] = useState<Preset>()
  const [busy, setBusy] = useState(false)

  const { normalizedOptions, valid } = useMemo(() => {
    const normalizedOptions = options.map((option) => option.trim())
    const normalizedQuestion = question.trim()
    const valid = Boolean(
      normalizedQuestion &&
      normalizedQuestion.length <= 500 &&
      normalizedOptions.length >= 2 &&
      normalizedOptions.length <= 10 &&
      normalizedOptions.every((option) => option && option.length <= 100) &&
      new Set(normalizedOptions.map((option) => option.toLocaleLowerCase())).size === normalizedOptions.length &&
      (!deadline || new Date(deadline).getTime() > Date.now()),
    )
    return { normalizedOptions, valid }
  }, [deadline, options, question])

  function fillPreset(next: Exclude<Preset, undefined>) {
    setPreset(next)
    setOptions(next === 'yes_no' ? ['Yes', 'No'] : ['👍', '👎'])
    setMulti(false)
  }

  function setDeadlineHours(hours: number) {
    const date = new Date(Date.now() + hours * 60 * 60 * 1000)
    const offset = date.getTimezoneOffset() * 60_000
    setDeadline(new Date(date.getTime() - offset).toISOString().slice(0, 16))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || busy) return
    const input = {
      question: question.trim(),
      options: normalizedOptions,
      multi,
      ...(deadline ? { expires_at: new Date(deadline).toISOString() } : {}),
    }
    setBusy(true)
    try {
      if (mode === 'call') {
        createCallPoll({ ...input, ...(preset ? { preset } : {}) })
      } else if (channelId) {
        await createPoll(channelId, { ...input, pinned })
      } else {
        throw new Error('Channel unavailable.')
      }
      onClose()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not create poll.')
      setBusy(false)
    }
  }

  return (
    <Modal title={mode === 'call' ? 'Quick poll' : 'Create poll'} onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-5">
        {/* TODO(ds): poll fields use the bg-ink surface + text-base tap sizing,
            which Input/Textarea can't express (surfaces are panel/panel-2 only). */}
        <div>
          <label htmlFor="poll-question" className="mb-1.5 block text-xs font-semibold text-[var(--color-text-dim)]">
            Question
          </label>
          <textarea
            id="poll-question"
            autoFocus
            rows={3}
            maxLength={500}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we decide?"
            className="w-full resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-ink)] px-3 py-2.5 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
          <div className="mt-1 text-right text-3xs tabular-nums text-[var(--color-text-faint)]">
            {question.length}/500
          </div>
        </div>

        {mode === 'call' ? (
          <fieldset>
            <legend className="mb-1.5 text-xs font-semibold text-[var(--color-text-dim)]">Preset</legend>
            <div className="flex gap-2">
              <PresetButton active={preset === 'yes_no'} onClick={() => fillPreset('yes_no')}>Yes / No</PresetButton>
              <PresetButton active={preset === 'thumbs'} onClick={() => fillPreset('thumbs')}>👍 / 👎</PresetButton>
            </div>
          </fieldset>
        ) : null}

        <fieldset>
          <div className="mb-2 flex items-center justify-between gap-3">
            <legend className="text-xs font-semibold text-[var(--color-text-dim)]">Options</legend>
            <span className="text-3xs tabular-nums text-[var(--color-text-faint)]">{options.length}/10</span>
          </div>
          <div className="space-y-2">
            {options.map((option, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-center text-xs tabular-nums text-[var(--color-text-faint)]">{index + 1}</span>
                <input
                  aria-label={`Option ${index + 1}`}
                  maxLength={100}
                  value={option}
                  onChange={(event) => {
                    setPreset(undefined)
                    setOptions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))
                  }}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-ink)] px-3 text-base text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
                  placeholder={`Option ${index + 1}`}
                />
                {options.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                    aria-label={`Remove option ${index + 1}`}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-faint)] hover:bg-danger-soft hover:text-danger-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                  >
                    <RemoveIcon />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {options.length < 10 ? (
            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ''])}
              className="mt-2 min-h-11 rounded-md px-2 text-xs font-semibold text-[var(--color-accent-hover)] hover:bg-[var(--color-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              + Add option
            </button>
          ) : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="Allow multiple choices"
            checked={multi}
            onChange={(checked) => {
              setPreset(undefined)
              setMulti(checked)
            }}
          />
          {mode === 'channel' ? (
            <ToggleRow label="Pin to channel" checked={pinned} onChange={setPinned} />
          ) : null}
        </div>

        <div>
          <label htmlFor="poll-deadline" className="mb-1.5 block text-xs font-semibold text-[var(--color-text-dim)]">
            Deadline <span className="font-normal text-[var(--color-text-faint)]">(optional)</span>
          </label>
          <input
            id="poll-deadline"
            type="datetime-local"
            value={deadline}
            min={new Date().toISOString().slice(0, 16)}
            onChange={(event) => setDeadline(event.target.value)}
            className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-ink)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
          />
          <div className="mt-2 flex gap-2">
            {[1, 4, 24].map((hours) => (
              <button key={hours} type="button" onClick={() => setDeadlineHours(hours)} className="min-h-9 rounded-full bg-[var(--color-panel-2)] px-3 text-2xs font-medium text-[var(--color-text-dim)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]">
                {hours}h
              </button>
            ))}
            {deadline ? (
              <button type="button" onClick={() => setDeadline('')} className="min-h-9 rounded-full px-3 text-2xs font-medium text-[var(--color-text-faint)] hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)]">
                Clear
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-[var(--color-border)] pt-4">
          <Button variant="ghost" size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={!valid || busy}>
            {busy ? 'Creating…' : mode === 'call' ? 'Start poll' : 'Create poll'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-ink)] px-3 text-sm text-[var(--color-text)]">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
    </label>
  )
}

function PresetButton({ children, active, onClick }: { children: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`min-h-11 rounded-lg border px-3 text-sm font-medium ${active ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent-hover)]' : 'border-[var(--color-border)] text-[var(--color-text-dim)] hover:bg-[var(--color-panel-2)]'}`}>
      {children}
    </button>
  )
}

function RemoveIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 12h14" />
    </svg>
  )
}
