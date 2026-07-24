import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { toastError } from '../../lib/toast'
import { Button, Input, Modal } from '../../ui'

export function NewMeetDialog({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

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
    <Modal
      title="New meet"
      onClose={onClose}
      size="md"
      initialFocusRef={inputRef}
      headerIcon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ff6b5f]/10 text-[#ff8a80] ring-1 ring-[#ff6b5f]/25">
          <StandaloneMeetIcon />
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="new-meet-form" disabled={!title.trim() || busy} className="min-w-28">
            {busy ? 'Creating…' : 'Start meet'}
          </Button>
        </>
      }
    >
      <form id="new-meet-form" onSubmit={create} className="space-y-5">
        <p className="text-sm leading-5 text-text-dim">
          Start a call with its own link, independent from channels and direct messages.
        </p>
        <label className="block" htmlFor="new-meet-name">
          <span className="meeting-label">Meet name</span>
          <Input
            ref={inputRef}
            id="new-meet-name"
            uiSize="lg"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={160}
            autoComplete="off"
            placeholder="Weekly product sync"
            className="mt-2"
          />
        </label>
      </form>
    </Modal>
  )
}

function StandaloneMeetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="13" height="14" rx="3" />
      <path d="m16 10 5-3v10l-5-3M9.5 9v6M6.5 12h6" />
    </svg>
  )
}
