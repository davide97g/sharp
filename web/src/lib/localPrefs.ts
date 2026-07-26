// Every browser-storage key the app uses, in one place, plus the accessors.
//
// Two reasons this file exists:
//
//   1. **A key registry.** Twenty-two `sharp.*` keys were declared in twenty-two files,
//      so nothing could answer "what do we persist on this device?" without a grep, and
//      nothing stopped two features from picking the same name.
//   2. **One safe accessor.** `window.localStorage` throws in Safari private mode and on
//      quota exhaustion, so every access needs a try/catch. That wrapper was hand-rolled
//      about twenty-five times; a missed one is a blank screen, not a lost preference.
//
// **What belongs here vs. on the server.** A key belongs in local storage only when it is
// genuinely device-scoped — which mic you use, how big this screen is, whether this tab
// has seen the changelog. Anything a user would expect to follow them to another device
// belongs in the synced appearance blob (`lib/uiPrefs.ts`, persisted via `PATCH /prefs/ui`)
// or in a real column (see server/src/routes/prefs.rs for why some are columns). Adding a
// preference here that should have been synced is the mistake to avoid.
//
// Guardrail: never put a secret or anything an XSS should not reach in here beyond the
// session token that already lives in `sharp.token`.

/**
 * Keys shared across the app. Scoped keys (per user, per project) are built by the
 * helpers below rather than listed, since their full names are dynamic.
 */
export const KEYS = {
  /** JWT for the current session. */
  token: 'sharp.token',
  /** Server URL entered at login; only used by the desktop build (see api.ts). */
  serverUrl: 'sharp.serverUrl',
  /** CSRF-style state for the desktop browser-login round trip. */
  desktopAuthState: 'sharp.desktopAuthState',
  /** Mirror of the synced appearance blob, read by the inline boot script in index.html. */
  ui: 'sharp.ui',
  /** The sound engine's own mirror of its settings (it owns the audio graph). */
  sounds: 'sharp.sounds',
  /** Last app version whose changelog this device has seen. */
  lastSeenVersion: 'sharp.lastSeenVersion',
  /** Whether the first-run tour has been completed. */
  onboarding: 'sharp.onboarding.v1',
  /** Quick-switcher frecency table — high-churn, deliberately not synced. */
  frecency: 'sharp.frecency',
  /** Mic denoising: depends on the physical mic, so device-local. */
  noiseSuppression: 'sharp.noiseSuppression',
  /** Streaming (privacy shield) manual toggle and its nickname-revert option. */
  streamManual: 'sharp.streamManual',
  streamRevertNicknames: 'sharp.streamRevertNicknames',
  /** Guest display name on a public call link. */
  guestName: 'sharp.guestName',
  /** Last-used calendar view (month/week/day). */
  calendarView: 'sharp.calendarView',
  /** Sidebar open/closed on narrow viewports. */
  sidebarOpen: 'sharp.sidebarOpen',
  /** Which corner the floating voice widget is parked in. */
  voiceWidgetCorner: 'sharp.voiceWidgetCorner',
  /** Legacy single-flag video blur, superseded by the scoped videoBackground key. */
  videoBlurLegacy: 'sharp.videoBlur',
  /** Seasonal pack forced on from Settings → Appearance ("Try it now"). Device-local
   *  on purpose: it is a preview of a dated event, not a preference to sync. */
  seasonPreview: 'sharp.seasonPreview',
} as const

/**
 * Prefixes for per-scope keys. Always build the full key with `scopedKey`, so the
 * separator and the version suffix stay consistent.
 */
export const KEY_PREFIXES = {
  /** Per user: `{audioDeviceId, videoDeviceId}`. */
  voiceDevices: 'sharp.voiceDevices.v1.',
  /** Per user: selected video background. */
  videoBackground: 'sharp.videoBackground.v1.',
  /** Per user: audio-aura on/off and its style. */
  audioAura: 'sharp.audioAura.v1.',
  audioAuraStyle: 'sharp.audioAuraStyle.v1.',
  /** Per project: 'list' | 'board'. */
  taskView: 'sharp.taskView.',
  /** Per orientation ('p'|'l'): best viewport height seen (iOS launch-bug workaround). */
  maxViewportHeight: 'sharp.maxViewportH.',
} as const

/**
 * Keys that pre-date the synced appearance blob. Read once during migration
 * (`lib/uiPrefs.ts`) and then left alone — do not write these.
 */
export const LEGACY_UI_KEYS = {
  theme: 'sharp.theme',
  railPosition: 'sharp.railPosition',
  dockAutoHide: 'sharp.dockAutoHide',
} as const

/** Build a per-scope key, e.g. `scopedKey(KEY_PREFIXES.taskView, projectId)`. */
export function scopedKey(prefix: string, scope: string): string {
  return `${prefix}${scope}`
}

// ── Accessors ────────────────────────────────────────────────────────────────────────
//
// All of them swallow storage failures. Reads fall back to the caller's default; writes
// are best-effort. A preference is never worth an exception.

export function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Returns false when storage rejected the write, for the rare caller that tells the user. */
export function writeLocal(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    /* storage unavailable (private mode, quota) */
    return false
  }
}

export function removeLocal(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}

/** Booleans are stored as '1'/'0'. `fallback` covers both "unset" and "unreadable". */
export function readLocalBool(key: string, fallback: boolean): boolean {
  const raw = readLocal(key)
  if (raw === null) return fallback
  return raw === '1'
}

export function writeLocalBool(key: string, value: boolean): boolean {
  return writeLocal(key, value ? '1' : '0')
}

/** Reads and parses JSON. A malformed value is treated as absent, not as an error. */
export function readLocalJson<T>(key: string, fallback: T): T {
  const raw = readLocal(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeLocalJson(key: string, value: unknown): boolean {
  try {
    return writeLocal(key, JSON.stringify(value))
  } catch {
    /* unserializable value — a preference is not worth throwing over */
    return false
  }
}

// ── sessionStorage ───────────────────────────────────────────────────────────────────
//
// Deliberately separate: these must NOT survive a tab close.

export const SESSION_KEYS = {
  /** Set at login, consumed once by the passkey-setup prompt. */
  offerPasskey: 'sharp.offerPasskey',
} as const

export function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

export function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key)
  } catch {
    /* storage unavailable */
  }
}
