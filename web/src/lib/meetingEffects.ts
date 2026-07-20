import { useSyncExternalStore } from 'react'

export type AudioAuraPreference = boolean | null

const STORAGE_PREFIX = 'sharp.audioAura.v1.'
const listeners = new Set<() => void>()
const memoryPreferences = new Map<string, boolean>()

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`
}

export function getAudioAuraPreference(userId?: string | null): AudioAuraPreference {
  if (!userId) return null
  try {
    const value = window.localStorage.getItem(storageKey(userId))
    if (value === '1') return true
    if (value === '0') return false
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return memoryPreferences.get(userId) ?? null
}

export function setAudioAuraPreference(userId: string, enabled: boolean): void {
  memoryPreferences.set(userId, enabled)
  try {
    window.localStorage.setItem(storageKey(userId), enabled ? '1' : '0')
  } catch {
    // The in-memory fallback keeps this choice stable for the current session.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX)) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useAudioAuraPreference(userId?: string | null): AudioAuraPreference {
  return useSyncExternalStore(
    subscribe,
    () => getAudioAuraPreference(userId),
    () => null,
  )
}
