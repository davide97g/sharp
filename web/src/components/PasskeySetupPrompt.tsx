import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { isPasskeyCancellation, registerPasskey, supportsPasskeys } from '../lib/passkeys'
import { toastError } from '../lib/toast'
import { Modal } from './Modal'
import { Button, Field, Input } from '../ui'

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
        <Field label="Passkey name">
          <Input uiSize="lg" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Confirm current password">
          <Input uiSize="lg" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => void dismiss()}>Not now</Button>
          <Button disabled={busy || !name.trim() || !password} onClick={() => void enroll()}>{busy ? 'Setting up…' : 'Create passkey'}</Button>
        </div>
      </div>
    </Modal>
  )
}
