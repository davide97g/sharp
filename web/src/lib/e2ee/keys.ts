import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { api, getToken, resolveBaseUrl } from '../api'
import { idbDelete, idbGet, idbPut } from './idb'

const DEVICE_KEY = 'local-device-v1'

export type LocalDevice = {
  id: string
  name: string
  x25519_priv: string
  x25519_pub: string
  ed25519_priv: string
  ed25519_pub: string
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url key')
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function shortDeviceName(): string {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /(?:Chrome|CriOS)\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Macintosh|Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS'
  return `${browser} on ${os}`
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function validLocalDevice(value: unknown): value is LocalDevice {
  if (!value || typeof value !== 'object') return false
  const device = value as Partial<LocalDevice>
  return (
    typeof device.id === 'string' &&
    typeof device.name === 'string' &&
    typeof device.x25519_priv === 'string' &&
    typeof device.x25519_pub === 'string' &&
    typeof device.ed25519_priv === 'string' &&
    typeof device.ed25519_pub === 'string'
  )
}

export function validateLocalDevice(device: LocalDevice): void {
  if (!validLocalDevice(device)) throw new Error('Invalid local encryption keys')
  const exchangePub = bytesToBase64Url(x25519.getPublicKey(base64UrlToBytes(device.x25519_priv)))
  const signingPub = bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(device.ed25519_priv)))
  if (exchangePub !== device.x25519_pub || signingPub !== device.ed25519_pub) {
    throw new Error('Encryption backup contains mismatched keys')
  }
}

export function localDeviceFromPrivate(
  value: Pick<LocalDevice, 'id' | 'name' | 'x25519_priv' | 'ed25519_priv'>,
): LocalDevice {
  return {
    ...value,
    x25519_pub: bytesToBase64Url(x25519.getPublicKey(base64UrlToBytes(value.x25519_priv))),
    ed25519_pub: bytesToBase64Url(ed25519.getPublicKey(base64UrlToBytes(value.ed25519_priv))),
  }
}

export async function saveLocalDevice(device: LocalDevice): Promise<void> {
  validateLocalDevice(device)
  await idbPut('keys', currentDeviceKey(), device)
}

export async function deleteLocalDevice(): Promise<void> {
  await idbDelete('keys', currentDeviceKey())
}

export async function getLocalDevice(): Promise<LocalDevice | null> {
  const stored = await idbGet<unknown>('keys', currentDeviceKey())
  return validLocalDevice(stored) ? stored : null
}

function currentDeviceKey(): string {
  const token = getToken()
  if (!token) return DEVICE_KEY
  try {
    const part = token.split('.')[1]
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    const payload = JSON.parse(atob(base64)) as { sub?: unknown }
    if (typeof payload.sub === 'string') return `${DEVICE_KEY}:${resolveBaseUrl()}:${payload.sub}`
  } catch {
    // A malformed token will fail API authentication; keep storage access deterministic meanwhile.
  }
  return DEVICE_KEY
}

let ensuring: Promise<LocalDevice> | null = null

export function ensureDevice(): Promise<LocalDevice> {
  if (ensuring) return ensuring
  ensuring = (async () => {
    let device = await getLocalDevice()
    if (!device) {
      const exchange = x25519.keygen(randomBytes(32))
      const signing = ed25519.keygen(randomBytes(32))
      device = {
        id: crypto.randomUUID(),
        name: shortDeviceName(),
        x25519_priv: bytesToBase64Url(exchange.secretKey),
        x25519_pub: bytesToBase64Url(exchange.publicKey),
        ed25519_priv: bytesToBase64Url(signing.secretKey),
        ed25519_pub: bytesToBase64Url(signing.publicKey),
      }
      await saveLocalDevice(device)
    }
    await api.registerDevice(device)
    return device
  })().finally(() => {
    ensuring = null
  })
  return ensuring
}

// Fingerprints persist in screenshots and verification records. Never reorder this table.
const FINGERPRINT_EMOJI = [
  '😀', '😎', '🤓', '🥳', '🤠', '👻', '🤖', '👽',
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
  '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐧',
  '🐦', '🦄', '🐝', '🦋', '🐢', '🐙', '🦀', '🐬',
  '🌵', '🌲', '🌴', '🍀', '🌻', '🌈', '⭐', '🌙',
  '☀️', '⚡', '🔥', '❄️', '🍎', '🍋', '🍉', '🍇',
  '🥑', '🍕', '🍪', '☕', '⚽', '🎲', '🎸', '🚗',
  '🚀', '✈️', '⌚', '💡', '🔑', '💎', '🎁', '❤️',
] as const

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export function fingerprint(
  x25519PubA: string,
  edPubA: string,
  x25519PubB: string,
  edPubB: string,
): string {
  const pairA = new Uint8Array([...base64UrlToBytes(x25519PubA), ...base64UrlToBytes(edPubA)])
  const pairB = new Uint8Array([...base64UrlToBytes(x25519PubB), ...base64UrlToBytes(edPubB)])
  const ordered = compareBytes(pairA, pairB) <= 0 ? [pairA, pairB] : [pairB, pairA]
  const digest = sha256(new Uint8Array([...ordered[0], ...ordered[1]]))
  const symbols: string[] = []
  for (let bit = 0; bit < 48; bit += 6) {
    const byte = Math.floor(bit / 8)
    const shift = bit % 8
    const word = (digest[byte] << 8) | (digest[byte + 1] ?? 0)
    symbols.push(FINGERPRINT_EMOJI[(word >> (10 - shift)) & 63])
  }
  return symbols.join(' ')
}

export function fingerprintDeviceSets(
  devicesA: Array<{ x25519_pub: string; ed25519_pub: string }>,
  devicesB: Array<{ x25519_pub: string; ed25519_pub: string }>,
): string {
  const aggregate = (devices: Array<{ x25519_pub: string; ed25519_pub: string }>) => {
    const sorted = devices
      .map((device) => `${device.x25519_pub}.${device.ed25519_pub}`)
      .sort()
      .join('|')
    const x = sha256(new TextEncoder().encode(`x:${sorted}`))
    const ed = sha256(new TextEncoder().encode(`ed:${sorted}`))
    return [bytesToBase64Url(x), bytesToBase64Url(ed)] as const
  }
  const a = aggregate(devicesA)
  const b = aggregate(devicesB)
  return fingerprint(a[0], a[1], b[0], b[1])
}

export function deviceSetHash(
  devicesA: Array<{ x25519_pub: string; ed25519_pub: string }>,
  devicesB: Array<{ x25519_pub: string; ed25519_pub: string }>,
): string {
  const sets = [devicesA, devicesB]
    .map((devices) => devices.map((d) => `${d.x25519_pub}.${d.ed25519_pub}`).sort().join('|'))
    .sort()
  return bytesToBase64Url(sha256(new TextEncoder().encode(sets.join('||'))))
}
