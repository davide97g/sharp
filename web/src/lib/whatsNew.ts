import { KEYS, readLocal, writeLocal } from './localPrefs'
import { cmpVersion, latestRelease } from './changelog'

export const LATEST_VERSION = latestRelease?.version ?? '0.0.0'

export function getLastSeenVersion(): string {
  // Unreadable storage reports "already seen" so a private-mode tab is not nagged.
  return readLocal(KEYS.lastSeenVersion) ?? '0.0.0'
}

export function setLastSeenVersion(version = LATEST_VERSION) {
  writeLocal(KEYS.lastSeenVersion, version)
  window.dispatchEvent(new Event('sharp:last-seen-version'))
}

export function hasUnseenRelease(): boolean {
  return cmpVersion(LATEST_VERSION, getLastSeenVersion()) > 0
}
