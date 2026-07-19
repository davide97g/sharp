import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { isPasskeyCancellation, registerPasskey, supportsPasskeys } from '../lib/passkeys'
import { toastError } from '../lib/toast'
import { Modal } from './Modal'

const OFFER_KEY = 'sharp.offerPasskey'

export function PasskeySetupPrompt() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('My passkey')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!supportsPasskeys() || sessionStorage.getItem(OFFER_KEY) !== '1') return
    sessionStorage.removeItem(OFFER_KEY)
    api.passkeys()
      .then((result) => {
        if (result.enabled && !result.prompt_dismissed && result.passkeys.length === 0) setOpen(true)
      })
      .catch(() => {})
  }, [])

  async function dismiss() {
    setOpen(false)
    try {
      await api.dismissPasskeyPrompt()
    } catch {
      // Prompt is already closed; management remains available in Settings.
    }
  }

  async function enroll() {
    if (!name.trim() || !password || busy) return
    setBusy(true)
    try {
      await registerPasskey(name.trim(), password)
      setOpen(false)
    } catch (error) {
      if (!isPasskeyCancellation(error)) {
        toastError(error instanceof Error ? error.message : 'Could not add passkey.')
      }
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  return (
    <Modal title="Set up a passkey" onClose={() => void dismiss()}>
      <div className="flex flex-col gap-4">
        <p className="text-sm leading-relaxed text-[var(--color-text-dim)]">
          Sign in next time with Face ID, Touch ID, Windows Hello, or a security key. Your password remains available for recovery.
        </p>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--color-text-dim)]">
          Passkey name
          <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none" />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--color-text-dim)]">
          Confirm current password
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2.5 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void dismiss()} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-dim)]">Not now</button>
          <button type="button" disabled={busy || !name.trim() || !password} onClick={() => void enroll()} className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Setting up…' : 'Create passkey'}</button>
        </div>
      </div>
    </Modal>
  )
}
