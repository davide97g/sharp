// Settings → Encryption and Passkeys.
//
// Contract: docs/arch/09-e2ee.md and the passkey section of docs/arch/01-core.md.
//
// Guardrail: private keys never leave the device. The backup flow encrypts them with a
// user passphrase client-side and the server only ever stores that opaque blob — do not
// add anything here that sends key material anywhere.

import { useEffect, useState } from 'react'
import { useStore } from '../../store'
import { api } from '../../lib/api'
import type {
  PasskeyRecord,
  E2eeBackup,
  E2eeDevice,
} from '../../lib/types'
import { toastError, toastSuccess } from '../../lib/toast'
import { ApiRequestError } from '../../lib/api'
import {
  deleteLocalDevice,
  ensureDevice,
  fingerprint,
  getDevices,
  getLocalDevice,
  invalidateDevices,
  type LocalDevice,
} from '../../lib/e2ee'
import { createBackup, restoreBackup } from '../../lib/e2ee/backup'
import { isTauri, openPasskeyManagement } from '../../lib/desktopAuth'
import { isPasskeyCancellation, registerPasskey, supportsPasskeys } from '../../lib/passkeys'
import { Button, Input, SectionLabel } from '../../ui'


export function EncryptionSettingsTab({ userId }: { userId: string }) {
  const [local, setLocal] = useState<LocalDevice | null>(null)
  const [devices, setDevices] = useState<E2eeDevice[]>([])
  const [backup, setBackup] = useState<E2eeBackup | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePassphrase, setRestorePassphrase] = useState('')

  async function load() {
    setLoading(true)
    try {
      const current = await getLocalDevice()
      invalidateDevices(userId)
      const own = await getDevices(userId)
      let status: E2eeBackup | null = null
      try {
        status = await api.getBackup()
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 404) throw error
      }
      setLocal(current)
      setDevices(own)
      setBackup(status)
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not load encryption settings.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [userId])

  async function revoke(device: E2eeDevice) {
    if (!window.confirm(`Revoke “${device.name}”? That device will lose access to new encrypted messages.`)) return
    setBusy(true)
    try {
      await api.deleteDevice(device.id)
      if (device.id === local?.id) {
        await deleteLocalDevice()
        await ensureDevice()
      }
      invalidateDevices(userId)
      await load()
      toastSuccess('Device revoked.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not revoke device.')
    } finally {
      setBusy(false)
    }
  }

  async function saveBackup() {
    if (passphrase.length < 8) return toastError('Backup passphrase must be at least 8 characters.')
    if (passphrase !== confirmPassphrase) return toastError('Passphrases do not match.')
    setBusy(true)
    try {
      await createBackup(passphrase)
      setPassphrase('')
      setConfirmPassphrase('')
      await load()
      toastSuccess('Encryption backup saved.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not save encryption backup.')
    } finally {
      setBusy(false)
    }
  }

  async function restore() {
    if (!restorePassphrase) return
    setBusy(true)
    try {
      await restoreBackup(restorePassphrase)
      invalidateDevices(userId)
      setRestorePassphrase('')
      setRestoreOpen(false)
      await load()
      await useStore.getState().refreshDmEncryption(userId)
      toastSuccess('Encryption keys restored.')
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not restore encryption backup.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="py-10 text-center text-sm text-[var(--color-text-faint)]">Loading encryption settings…</div>
  const shortFingerprint = local
    ? fingerprint(local.x25519_pub, local.ed25519_pub, local.x25519_pub, local.ed25519_pub)
        .split(' ')
        .slice(0, 4)
        .join(' ')
    : 'Unavailable'

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionLabel size="xs" className="mb-2 block">This device</SectionLabel>
        {local ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-3 text-sm">
            <dt className="text-[var(--color-text-faint)]">Name</dt><dd>{local.name}</dd>
            <dt className="text-[var(--color-text-faint)]">Fingerprint</dt><dd className="tracking-wider">{shortFingerprint}</dd>
            <dt className="text-[var(--color-text-faint)]">Device id</dt><dd className="truncate font-mono text-xs" title={local.id}>{local.id}</dd>
          </dl>
        ) : <p className="text-sm text-[var(--color-text-dim)]">No encryption identity on this browser.</p>}
      </section>

      <section>
        <SectionLabel size="xs" className="mb-2 block">My devices</SectionLabel>
        <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          {devices.map((device) => (
            <div key={device.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0"><div className="truncate text-sm font-medium">{device.name}{device.id === local?.id ? ' · Current' : ''}</div><div className="text-2xs text-[var(--color-text-faint)]">Added {new Date(device.created_at).toLocaleDateString()}</div></div>
              <button type="button" disabled={busy} onClick={() => void revoke(device)} className="shrink-0 text-xs text-danger-fg disabled:opacity-50">Revoke</button>
            </div>
          ))}
          {!devices.length ? <div className="p-3 text-sm text-[var(--color-text-faint)]">No registered devices.</div> : null}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div><SectionLabel size="xs">Backup</SectionLabel><p className="mt-1 text-xs text-[var(--color-text-dim)]">{backup ? `Saved ${new Date(backup.updated_at).toLocaleString()}` : 'No backup saved'}</p></div>
        <Input type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder={backup ? 'New passphrase' : 'Passphrase (8+ characters)'} />
        <Input type="password" autoComplete="new-password" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} placeholder="Confirm passphrase" />
        <div className="flex flex-wrap gap-2"><Button disabled={busy || !passphrase || !confirmPassphrase} onClick={() => void saveBackup()}>{busy ? 'Working…' : backup ? 'Change passphrase' : 'Set passphrase'}</Button><Button variant="outline" disabled={busy || !backup} onClick={() => setRestoreOpen((open) => !open)}>Restore from backup</Button></div>
        {restoreOpen ? <div className="flex gap-2 rounded-lg border border-[var(--color-border)] p-3"><Input type="password" autoComplete="current-password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} placeholder="Backup passphrase" className="min-w-0 flex-1" /><Button disabled={busy || !restorePassphrase} onClick={() => void restore()}>Restore</Button></div> : null}
      </section>
    </div>
  )
}

export function PasskeySecurityTab() {
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([])
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [name, setName] = useState('My passkey')
  const [password, setPassword] = useState('')
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      const result = await api.passkeys()
      setEnabled(result.enabled)
      setPasskeys(result.passkeys)
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not load passkeys.')
    }
  }

  useEffect(() => { void load() }, [])

  async function add() {
    if (!name.trim() || !password || busy) return
    setBusy(true)
    try {
      await registerPasskey(name.trim(), password)
      setPassword('')
      await load()
    } catch (error) {
      if (!isPasskeyCancellation(error)) toastError(error instanceof Error ? error.message : 'Could not add passkey.')
    } finally {
      setBusy(false)
    }
  }

  async function rename(passkey: PasskeyRecord) {
    const next = window.prompt('Passkey name', passkey.name)?.trim()
    if (!next || next === passkey.name) return
    try {
      await api.renamePasskey(passkey.id, next)
      await load()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not rename passkey.')
    }
  }

  async function remove() {
    if (!removeId || !password || busy) return
    setBusy(true)
    try {
      await api.removePasskey(removeId, password)
      setPassword('')
      setRemoveId(null)
      await load()
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not remove passkey.')
    } finally {
      setBusy(false)
    }
  }

  if (enabled === null) return <div className="py-10 text-center text-sm text-[var(--color-text-faint)]">Loading security settings…</div>
  if (!enabled) return <div className="text-sm text-[var(--color-text-dim)]">Passkeys are not configured on this Sharp server.</div>
  if (isTauri) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[var(--color-text-dim)]">Manage passkeys in your system browser so Face ID, Touch ID, Windows Hello, and security keys can verify the Sharp server.</p>
        <Button className="self-start" onClick={() => void openPasskeyManagement().catch((error) => toastError(error instanceof Error ? error.message : 'Could not open browser.'))}>Manage passkeys in browser</Button>
      </div>
    )
  }
  if (!supportsPasskeys()) return <div className="text-sm text-[var(--color-text-dim)]">This browser cannot use passkeys. Open Sharp over HTTPS in a supported browser.</div>

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionLabel size="xs" className="mb-1 block">Your passkeys</SectionLabel>
        <p className="text-xs text-[var(--color-text-dim)]">Your password remains available for account recovery.</p>
      </div>
      {passkeys.length === 0 ? <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4 text-sm text-[var(--color-text-faint)]">No passkeys enrolled.</div> : (
        <div className="flex flex-col divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-text)]">{passkey.name}</div>
                <div className="text-2xs text-[var(--color-text-faint)]">Added {new Date(passkey.created_at).toLocaleDateString()}{passkey.last_used_at ? ` · Last used ${new Date(passkey.last_used_at).toLocaleDateString()}` : ''}</div>
              </div>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={() => void rename(passkey)} className="text-xs text-[var(--color-accent-hover)]">Rename</button>
                <button type="button" onClick={() => { setRemoveId(passkey.id); setPassword('') }} className="text-xs text-danger-fg">Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] p-3">
        <div className="text-sm font-semibold">Add passkey</div>
        <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Passkey name" />
        <Input type="password" autoComplete="current-password" value={removeId ? '' : password} onChange={(event) => setPassword(event.target.value)} placeholder="Confirm current password" disabled={removeId !== null} />
        <Button className="self-start" disabled={busy || !!removeId || !name.trim() || !password} onClick={() => void add()}>{busy ? 'Working…' : 'Add passkey'}</Button>
      </div>
      {removeId && (
        <div className="flex flex-col gap-2 rounded-lg border border-danger-fg/40 bg-danger-soft p-3">
          <div className="text-sm font-semibold">Remove passkey?</div>
          <Input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Confirm current password" />
          <div className="flex gap-2">
            <Button variant="danger" disabled={busy || !password} onClick={() => void remove()}>Remove</Button>
            <Button variant="outline" onClick={() => { setRemoveId(null); setPassword('') }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  )
}
