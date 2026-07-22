import { useSyncExternalStore } from 'react'

export type AudioAuraPreference = boolean | null
export type AudioAuraStyle = 'helios' | 'mercury' | 'voiceprint' | 'kinetic-type' | 'eclipse'

const STORAGE_PREFIX = 'sharp.audioAura.v1.'
const STYLE_STORAGE_PREFIX = 'sharp.audioAuraStyle.v1.'
export const DEFAULT_AUDIO_AURA_STYLE: AudioAuraStyle = 'helios'
const listeners = new Set<() => void>()
const memoryPreferences = new Map<string, boolean>()
const memoryStyles = new Map<string, AudioAuraStyle>()

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`
}

function styleStorageKey(userId: string): string {
  return `${STYLE_STORAGE_PREFIX}${encodeURIComponent(userId)}`
}

function isAudioAuraStyle(value: string | null): value is AudioAuraStyle {
  return value === 'helios' ||
    value === 'mercury' ||
    value === 'voiceprint' ||
    value === 'kinetic-type' ||
    value === 'eclipse'
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

export function getAudioAuraStyle(userId?: string | null): AudioAuraStyle {
  if (!userId) return DEFAULT_AUDIO_AURA_STYLE
  try {
    const value = window.localStorage.getItem(styleStorageKey(userId))
    if (isAudioAuraStyle(value)) return value
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return memoryStyles.get(userId) ?? DEFAULT_AUDIO_AURA_STYLE
}

export function setAudioAuraStyle(userId: string, style: AudioAuraStyle): void {
  memoryStyles.set(userId, style)
  try {
    window.localStorage.setItem(styleStorageKey(userId), style)
  } catch {
    // The in-memory fallback keeps this choice stable for the current session.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(STORAGE_PREFIX) || event.key?.startsWith(STYLE_STORAGE_PREFIX)) listener()
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

export function useAudioAuraStyle(userId?: string | null): AudioAuraStyle {
  return useSyncExternalStore(
    subscribe,
    () => getAudioAuraStyle(userId),
    () => DEFAULT_AUDIO_AURA_STYLE,
  )
}
