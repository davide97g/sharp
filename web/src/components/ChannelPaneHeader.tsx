import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store'
import { channelLabel } from '../lib/util'
import { Avatar } from './Avatar'
import { LockIcon } from './icons'
import type { Channel } from '../lib/types'
import { deviceSetHash, fingerprintDeviceSets, getDevices } from '../lib/e2ee'
import { getTrustState, setDeviceSetVerified } from '../lib/e2ee/trust'
import { toastError } from '../lib/toast'
import { Modal } from './Modal'

// The channel identity row (DM avatar+name or #channel) reused by the docs /
// canvas gallery tabs so they match the chat pane's header. `actions` renders
// on the right (e.g. a "+ New" button).
export function ChannelPaneHeader({
  channel,
  actions,
}: {
  channel: Channel
  actions?: React.ReactNode
}) {
  const online = useStore((s) => s.online)
  const isDm = channel.kind === 'dm'
  const encrypted = useStore((state) => state.dmEncryption[channel.id] === true)
  const me = useStore((state) => state.me)
  const dmOnline = isDm && channel.dm_user ? online.has(channel.dm_user.id) : undefined
  const [verificationOpen, setVerificationOpen] = useState(false)
  const [verification, setVerification] = useState<{
    fingerprint: string
    hash: string
    verified: boolean
    changed: boolean
  } | null>(null)

  const loadVerification = useCallback(async () => {
    if (!encrypted || !me || !channel.dm_user) return
    try {
      const [mine, partner] = await Promise.all([getDevices(me.id), getDevices(channel.dm_user.id)])
      const hash = deviceSetHash(mine, partner)
      const trust = await getTrustState(channel.dm_user.id, hash)
      setVerification({ fingerprint: fingerprintDeviceSets(mine, partner), hash, ...trust })
    } catch (error) {
      if (verificationOpen) toastError(error instanceof Error ? error.message : 'Could not load verification details.')
    }
  }, [channel.dm_user, encrypted, me, verificationOpen])

  useEffect(() => {
    void loadVerification()
    const refresh = () => void loadVerification()
    window.addEventListener('sharp:e2ee-trust-changed', refresh)
    return () => window.removeEventListener('sharp:e2ee-trust-changed', refresh)
  }, [loadVerification])

  async function toggleVerified() {
    if (!verification || !channel.dm_user) return
    await setDeviceSetVerified(channel.dm_user.id, verification.hash, !verification.verified)
    setVerification({ ...verification, verified: !verification.verified, changed: false })
  }

  return (
    <header className="flex h-14 items-center gap-2 border-b border-[var(--color-border)] px-4">
      <div className="flex min-w-0 items-center gap-2">
        {isDm ? (
          <span className="flex items-center gap-2 font-semibold">
            {channel.dm_user && (
              <Avatar
                id={channel.dm_user.id}
                name={channel.dm_user.display_name}
                size={26}
                online={dmOnline}
              />
            )}
            {channelLabel(channel)}
            {encrypted && (
              <button type="button" onClick={() => { setVerificationOpen(true); void loadVerification() }} className="shrink-0 text-[var(--color-text-faint)] hover:text-[var(--color-text)]" title="End-to-end encrypted · Verify">
                <LockIcon />
              </button>
            )}
            {verification?.changed ? <span className="text-[11px] font-normal text-amber-400">⚠ device list changed</span> : null}
          </span>
        ) : (
          <span className="flex items-center gap-1 font-semibold">
            <span className="text-[var(--color-text-faint)]">#</span>
            {channel.name}
            {channel.kind === 'private' && (
              <span className="shrink-0 text-[var(--color-text-faint)]" title="Private">
                <LockIcon />
              </span>
            )}
          </span>
        )}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1">{actions}</div>}
      {verificationOpen && channel.dm_user ? (
        <Modal title="Verify encrypted conversation" onClose={() => setVerificationOpen(false)}>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-[var(--color-text-dim)]">Compare these emoji with {channel.dm_user.display_name} over another channel.</p>
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-panel-2)] p-4 text-center text-2xl leading-relaxed tracking-wider">{verification?.fingerprint ?? 'Loading…'}</div>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--color-border)] p-3 text-sm"><input type="checkbox" checked={verification?.verified ?? false} disabled={!verification} onChange={() => void toggleVerified()} className="h-4 w-4 accent-[var(--color-accent)]" /><span>Mark as verified</span></label>
            {verification?.changed ? <p className="text-xs text-amber-400">Device list changed since last verification. Compare again before marking verified.</p> : null}
          </div>
        </Modal>
      ) : null}
    </header>
  )
}
