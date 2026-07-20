// Preferred audio/video capture devices, remembered per user in this browser.
// Device IDs are only meaningful on the machine that enumerated them, so — like
// the video-background preference — these live in localStorage, never the server.

export type VoiceDevicePrefs = {
  audioDeviceId: string | null
  videoDeviceId: string | null
}

const STORAGE_PREFIX = 'sharp.voiceDevices.v1.'

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`
}

export function loadVoiceDevicePrefs(userId?: string | null): VoiceDevicePrefs {
  const empty: VoiceDevicePrefs = { audioDeviceId: null, videoDeviceId: null }
  try {
    if (!userId) return empty
    const raw = window.localStorage.getItem(storageKey(userId))
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Partial<VoiceDevicePrefs>
    return {
      audioDeviceId: typeof parsed.audioDeviceId === 'string' ? parsed.audioDeviceId : null,
      videoDeviceId: typeof parsed.videoDeviceId === 'string' ? parsed.videoDeviceId : null,
    }
  } catch {
    // Storage may be blocked in private/restricted contexts.
    return empty
  }
}

function save(userId: string, prefs: VoiceDevicePrefs): boolean {
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(prefs))
    return true
  } catch {
    return false
  }
}

export function saveVoiceAudioDevice(userId: string, deviceId: string | null): boolean {
  return save(userId, { ...loadVoiceDevicePrefs(userId), audioDeviceId: deviceId })
}

export function saveVoiceVideoDevice(userId: string, deviceId: string | null): boolean {
  return save(userId, { ...loadVoiceDevicePrefs(userId), videoDeviceId: deviceId })
}
