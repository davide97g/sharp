import { idbDelete, idbGet, idbPut } from './idb'

type TrustMeta = { userId: string; hash: string; verified: boolean; changed: boolean }

const key = (userId: string, hash: string) => `verified:${userId}:${hash}`
const metaKey = (userId: string) => `meta:${userId}`
const notify = () => window.dispatchEvent(new Event('sharp:e2ee-trust-changed'))

export async function getTrustState(userId: string, hash: string): Promise<{ verified: boolean; changed: boolean }> {
  const [verified, meta] = await Promise.all([
    idbGet<boolean>('trust', key(userId, hash)),
    idbGet<TrustMeta>('trust', metaKey(userId)),
  ])
  if (meta?.verified && meta.hash !== hash) {
    await idbDelete('trust', key(userId, meta.hash))
    await idbPut<TrustMeta>('trust', metaKey(userId), {
      userId,
      hash,
      verified: false,
      changed: true,
    })
    return { verified: false, changed: true }
  }
  return { verified: verified === true, changed: meta?.changed === true }
}

export async function setDeviceSetVerified(userId: string, hash: string, verified: boolean): Promise<void> {
  if (verified) await idbPut('trust', key(userId, hash), true)
  else await idbDelete('trust', key(userId, hash))
  await idbPut<TrustMeta>('trust', metaKey(userId), { userId, hash, verified, changed: false })
  notify()
}

export async function markDeviceSetChanged(userId: string): Promise<void> {
  void userId
  notify()
}

export async function markAllDeviceSetsChanged(): Promise<void> {
  notify()
}
