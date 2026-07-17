import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'

export function NewMeetDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => previousFocus?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
      if (event.key !== 'Tab') return
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      )
      if (!controls?.length) return
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    const value = title.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const call = await api.calls.create(value)
      navigate(`/call/${call.token}`)
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not create meet.')
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-meet-title"
        aria-describedby="new-meet-description"
        className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] shadow-2xl"
      >
        <div className="flex items-start gap-4 border-b border-[var(--color-border)] p-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#ff6b5f]/10 text-[#ff8a80] ring-1 ring-[#ff6b5f]/25">
            <StandaloneMeetIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="new-meet-title" className="text-lg font-semibold">New meet</h2>
            <p id="new-meet-description" className="mt-1 text-sm leading-5 text-[var(--color-text-dim)]">
              Start a call with its own link, independent from channels and direct messages.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-text-faint)] transition hover:bg-[var(--color-panel-2)] hover:text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:opacity-40"
            aria-label="Close new meet dialog"
          >
            <CloseIcon />
          </button>
        </div>

        <form onSubmit={create} className="space-y-5 p-5">
          <label className="block" htmlFor="new-meet-name">
            <span className="meeting-label">Meet name</span>
            <input
              ref={inputRef}
              id="new-meet-name"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={160}
              autoComplete="off"
              placeholder="Weekly product sync"
              className="mt-2 h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 text-base outline-none placeholder:text-[var(--color-text-faint)] focus:border-[var(--color-accent)] focus:ring-2 focus:ring-[var(--color-accent-soft)]"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="meeting-button h-11 disabled:opacity-40">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || busy}
              className="meeting-button-primary h-11 min-w-28 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? 'Creating…' : 'Start meet'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}

function StandaloneMeetIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="13" height="14" rx="3" />
      <path d="m16 10 5-3v10l-5-3M9.5 9v6M6.5 12h6" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}
