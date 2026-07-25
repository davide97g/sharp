// Preferred audio/video capture devices, remembered per user in this browser.
// Device IDs are only meaningful on the machine that enumerated them, so — like
// the video-background preference — these live in localStorage, never the server.

import { KEY_PREFIXES, readLocalJson, scopedKey, writeLocalJson } from './localPrefs'

export type VoiceDevicePrefs = {
  audioDeviceId: string | null
  videoDeviceId: string | null
}

function storageKey(userId: string): string {
  return scopedKey(KEY_PREFIXES.voiceDevices, encodeURIComponent(userId))
}

export function loadVoiceDevicePrefs(userId?: string | null): VoiceDevicePrefs {
  const empty: VoiceDevicePrefs = { audioDeviceId: null, videoDeviceId: null }
  if (!userId) return empty
  const parsed = readLocalJson<Partial<VoiceDevicePrefs>>(storageKey(userId), {})
  // Re-validate: a stale or hand-edited blob must not put a non-string into a
  // getUserMedia constraint.
  return {
    audioDeviceId: typeof parsed.audioDeviceId === 'string' ? parsed.audioDeviceId : null,
    videoDeviceId: typeof parsed.videoDeviceId === 'string' ? parsed.videoDeviceId : null,
  }
}

function save(userId: string, prefs: VoiceDevicePrefs): void {
  writeLocalJson(storageKey(userId), prefs)
}

export function saveVoiceAudioDevice(userId: string, deviceId: string | null): void {
  save(userId, { ...loadVoiceDevicePrefs(userId), audioDeviceId: deviceId })
}

export function saveVoiceVideoDevice(userId: string, deviceId: string | null): void {
  save(userId, { ...loadVoiceDevicePrefs(userId), videoDeviceId: deviceId })
}
