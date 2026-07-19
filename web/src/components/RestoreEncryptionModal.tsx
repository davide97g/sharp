import { useState } from 'react'
import { useStore } from '../store'
import { toastError } from '../lib/toast'
import { Modal } from './Modal'

export function RestoreEncryptionModal() {
  const open = useStore((s) => s.backupRestorePrompt)
  const restore = useStore((s) => s.restoreEncryptionBackup)
  const startFresh = useStore((s) => s.startFreshEncryption)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open) return null

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not initialize encryption keys.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Restore encryption keys" onClose={() => {}}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[var(--color-text-dim)]">
          This browser has no encryption keys, but your account has a backup. Restore it to read encrypted message history.
        </p>
        <input
          type="password"
          autoComplete="current-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && passphrase && void run(() => restore(passphrase))}
          placeholder="Backup passphrase"
          className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !passphrase} onClick={() => void run(() => restore(passphrase))} className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? 'Working…' : 'Restore'}
          </button>
          <button type="button" disabled={busy} onClick={() => void run(startFresh)} className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-text-dim)] disabled:opacity-50">
            Start fresh
          </button>
        </div>
        <p className="text-xs text-[var(--color-text-faint)]">Starting fresh leaves old encrypted history unreadable on this browser.</p>
      </div>
    </Modal>
  )
}
