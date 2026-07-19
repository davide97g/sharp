import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { api } from '../api'
import {
  getLocalDevice,
  localDeviceFromPrivate,
  saveLocalDevice,
  validateLocalDevice,
  type LocalDevice,
} from './keys'

export class BackupError extends Error {
  constructor(public readonly code: 'missing_keys' | 'wrong_passphrase' | 'invalid_backup') {
    super(code === 'wrong_passphrase' ? 'Wrong backup passphrase' : code === 'missing_keys' ? 'No local encryption keys to back up' : 'Invalid encryption backup')
    this.name = 'BackupError'
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new BackupError('invalid_backup')
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function derive(passphrase: string, salt: Uint8Array): Uint8Array {
  return argon2id(encoder.encode(passphrase), salt, { t: 3, m: 65_536, p: 1, dkLen: 32 })
}

export async function createBackup(passphrase: string): Promise<void> {
  const device = await getLocalDevice()
  if (!device) throw new BackupError('missing_keys')
  const salt = randomBytes(16)
  const nonce = randomBytes(24)
  const key = derive(passphrase, salt)
  const payload = {
    id: device.id,
    name: device.name,
    x25519_priv: device.x25519_priv,
    ed25519_priv: device.ed25519_priv,
  }
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(encoder.encode(JSON.stringify(payload)))
  await api.putBackup({ salt: toBase64Url(salt), nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) })
}

function parseDevice(value: unknown): LocalDevice {
  if (!value || typeof value !== 'object') throw new BackupError('invalid_backup')
  const device = value as Partial<LocalDevice>
  for (const field of ['id', 'name', 'x25519_priv', 'ed25519_priv'] as const) {
    if (typeof device[field] !== 'string') throw new BackupError('invalid_backup')
  }
  try {
    return localDeviceFromPrivate(device as Pick<LocalDevice, 'id' | 'name' | 'x25519_priv' | 'ed25519_priv'>)
  } catch {
    throw new BackupError('invalid_backup')
  }
}

export async function restoreBackup(passphrase: string): Promise<LocalDevice> {
  const backup = await api.getBackup()
  let device: LocalDevice
  try {
    const salt = fromBase64Url(backup.salt)
    const nonce = fromBase64Url(backup.nonce)
    const key = derive(passphrase, salt)
    const plaintext = xchacha20poly1305(key, nonce).decrypt(fromBase64Url(backup.ciphertext))
    device = parseDevice(JSON.parse(decoder.decode(plaintext)))
  } catch (error) {
    if (error instanceof BackupError && error.code === 'invalid_backup') throw error
    throw new BackupError('wrong_passphrase')
  }
  validateLocalDevice(device)
  await api.registerDevice(device)
  await saveLocalDevice(device)
  return device
}
