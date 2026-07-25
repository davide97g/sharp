import { useSyncExternalStore } from 'react'
import { KEY_PREFIXES, readLocal, scopedKey, writeLocal, writeLocalBool } from './localPrefs'

export type AudioAuraPreference = boolean | null
export type AudioAuraStyle = 'helios' | 'mercury' | 'voiceprint' | 'kinetic-type' | 'eclipse'

export const DEFAULT_AUDIO_AURA_STYLE: AudioAuraStyle = 'helios'
const listeners = new Set<() => void>()
const memoryPreferences = new Map<string, boolean>()
const memoryStyles = new Map<string, AudioAuraStyle>()

function storageKey(userId: string): string {
  return scopedKey(KEY_PREFIXES.audioAura, encodeURIComponent(userId))
}

function styleStorageKey(userId: string): string {
  return scopedKey(KEY_PREFIXES.audioAuraStyle, encodeURIComponent(userId))
}

export function isAudioAuraStyle(value: string | null): value is AudioAuraStyle {
  return value === 'helios' ||
    value === 'mercury' ||
    value === 'voiceprint' ||
    value === 'kinetic-type' ||
    value === 'eclipse'
}

export function getAudioAuraPreference(userId?: string | null): AudioAuraPreference {
  if (!userId) return null
  const value = readLocal(storageKey(userId))
  if (value === '1') return true
  if (value === '0') return false
  // The in-memory map is the fallback when storage is blocked entirely.
  return memoryPreferences.get(userId) ?? null
}

export function setAudioAuraPreference(userId: string, enabled: boolean): void {
  // Written to memory first so the choice holds for this session even if storage is
  // blocked.
  memoryPreferences.set(userId, enabled)
  writeLocalBool(storageKey(userId), enabled)
  for (const listener of listeners) listener()
}

export function getAudioAuraStyle(userId?: string | null): AudioAuraStyle {
  if (!userId) return DEFAULT_AUDIO_AURA_STYLE
  const value = readLocal(styleStorageKey(userId))
  if (isAudioAuraStyle(value)) return value
  return memoryStyles.get(userId) ?? DEFAULT_AUDIO_AURA_STYLE
}

export function setAudioAuraStyle(userId: string, style: AudioAuraStyle): void {
  memoryStyles.set(userId, style)
  writeLocal(styleStorageKey(userId), style)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    // Cross-tab sync: another tab changing either key re-renders this one.
    if (
      event.key?.startsWith(KEY_PREFIXES.audioAura) ||
      event.key?.startsWith(KEY_PREFIXES.audioAuraStyle)
    ) {
      listener()
    }
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
