import { api } from '../api'
import type { E2eeDevice } from '../types'

export type Device = E2eeDevice

const cache = new Map<string, Promise<Device[]>>()

export function getDevices(userId: string): Promise<Device[]> {
  const cached = cache.get(userId)
  if (cached) return cached
  const pending = api.e2eeDevices(userId).then(({ devices }) => devices)
  cache.set(userId, pending)
  pending.catch(() => {
    if (cache.get(userId) === pending) cache.delete(userId)
  })
  return pending
}

export function invalidateDevices(userId: string): void {
  cache.delete(userId)
}
