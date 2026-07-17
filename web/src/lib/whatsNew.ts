import { cmpVersion, latestRelease } from './changelog'

const STORAGE_KEY = 'sharp.lastSeenVersion'
export const LATEST_VERSION = latestRelease?.version ?? '0.0.0'

export function getLastSeenVersion(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? '0.0.0'
  } catch {
    return LATEST_VERSION
  }
}

export function setLastSeenVersion(version = LATEST_VERSION) {
  try {
    window.localStorage.setItem(STORAGE_KEY, version)
    window.dispatchEvent(new Event('sharp:last-seen-version'))
  } catch {
    /* ignore */
  }
}

export function hasUnseenRelease(): boolean {
  return cmpVersion(LATEST_VERSION, getLastSeenVersion()) > 0
}
