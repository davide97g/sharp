import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { E2eeDevice, EncryptedAttachment, EncryptedBody } from '../types'
import type { Device } from './devices'
import { getLocalDevice, type LocalDevice } from './keys'

export type E2eeErrorCode = 'no_key' | 'bad_sig' | 'corrupt'

export class E2eeError extends Error {
  constructor(public readonly code: E2eeErrorCode) {
    super(
      code === 'no_key'
        ? 'No key for this device'
        : code === 'bad_sig'
          ? 'Invalid message signature'
          : 'Corrupt encrypted message',
    )
    this.name = 'E2eeError'
  }
}

type Envelope = {
  v: 1
  dev: string
  epk: string
  n: string
  ct: string
  keys: Record<string, string>
  sig: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const WRAP_INFO = encoder.encode('sharp-e2ee-v1')

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid base64url')
  const base64 =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function bytes(value: string, length?: number): Uint8Array {
  const decoded = fromBase64Url(value)
  if (length !== undefined && decoded.length !== length) throw new Error('Invalid byte length')
  return decoded
}

function parseEnvelope(value: string): Envelope {
  const parsed = JSON.parse(decoder.decode(fromBase64Url(value))) as Partial<Envelope>
  if (
    parsed.v !== 1 ||
    typeof parsed.dev !== 'string' ||
    typeof parsed.epk !== 'string' ||
    typeof parsed.n !== 'string' ||
    typeof parsed.ct !== 'string' ||
    typeof parsed.sig !== 'string' ||
    !parsed.keys ||
    typeof parsed.keys !== 'object' ||
    Array.isArray(parsed.keys) ||
    !Object.values(parsed.keys).every((item) => typeof item === 'string')
  ) {
    throw new Error('Invalid envelope')
  }
  bytes(parsed.epk, 32)
  bytes(parsed.n, 24)
  bytes(parsed.sig, 64)
  bytes(parsed.ct)
  return parsed as Envelope
}

function validAttachment(value: unknown): value is EncryptedAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<EncryptedAttachment>
  return ['id', 'key', 'nonce', 'filename', 'content_type'].every(
    (field) => typeof item[field as keyof EncryptedAttachment] === 'string',
  )
}

function parseBody(value: Uint8Array): EncryptedBody {
  const parsed = JSON.parse(decoder.decode(value)) as Partial<EncryptedBody>
  if (!parsed || typeof parsed.text !== 'string') throw new Error('Invalid encrypted body')
  if (
    parsed.attachments !== undefined &&
    (!Array.isArray(parsed.attachments) || !parsed.attachments.every(validAttachment))
  ) {
    throw new Error('Invalid encrypted attachments')
  }
  return parsed as EncryptedBody
}

export function sealMessage(
  body: EncryptedBody,
  recipients: Device[],
  sender: LocalDevice,
): string {
  if (recipients.length === 0) throw new E2eeError('no_key')
  try {
    const messageKey = randomBytes(32)
    const nonce = randomBytes(24)
    const ciphertext = xchacha20poly1305(messageKey, nonce).encrypt(
      encoder.encode(JSON.stringify(body)),
    )
    const ephemeral = x25519.keygen(randomBytes(32))
    const wrapped: Record<string, string> = {}
    for (const recipient of recipients) {
      const shared = x25519.getSharedSecret(
        ephemeral.secretKey,
        bytes(recipient.x25519_pub, 32),
      )
      const wrapKey = hkdf(sha256, shared, undefined, WRAP_INFO, 32)
      const wrapNonce = randomBytes(24)
      wrapped[recipient.id] = toBase64Url(
        concat(wrapNonce, xchacha20poly1305(wrapKey, wrapNonce).encrypt(messageKey)),
      )
    }
    const envelope: Envelope = {
      v: 1,
      dev: sender.id,
      epk: toBase64Url(ephemeral.publicKey),
      n: toBase64Url(nonce),
      ct: toBase64Url(ciphertext),
      keys: wrapped,
      sig: toBase64Url(ed25519.sign(ciphertext, bytes(sender.ed25519_priv, 32))),
    }
    return toBase64Url(encoder.encode(JSON.stringify(envelope)))
  } catch (error) {
    if (error instanceof E2eeError) throw error
    throw new E2eeError('corrupt')
  }
}

export async function openMessage(
  envB64: string,
  fetchSender: (deviceId: string) => Promise<E2eeDevice | null>,
): Promise<EncryptedBody> {
  let envelope: Envelope
  try {
    envelope = parseEnvelope(envB64)
  } catch {
    throw new E2eeError('corrupt')
  }

  const ciphertext = bytes(envelope.ct)
  let sender: E2eeDevice | null
  try {
    sender = await fetchSender(envelope.dev)
  } catch {
    throw new E2eeError('bad_sig')
  }
  if (!sender) throw new E2eeError('bad_sig')
  try {
    if (!ed25519.verify(bytes(envelope.sig, 64), ciphertext, bytes(sender.ed25519_pub, 32))) {
      throw new E2eeError('bad_sig')
    }
  } catch (error) {
    if (error instanceof E2eeError) throw error
    throw new E2eeError('bad_sig')
  }

  let local: LocalDevice | null
  try {
    local = await getLocalDevice()
  } catch {
    throw new E2eeError('corrupt')
  }
  if (!local || !envelope.keys[local.id]) throw new E2eeError('no_key')
  try {
    const blob = bytes(envelope.keys[local.id])
    if (blob.length !== 24 + 32 + 16) throw new Error('Invalid wrapped key')
    const wrapNonce = blob.subarray(0, 24)
    const shared = x25519.getSharedSecret(
      bytes(local.x25519_priv, 32),
      bytes(envelope.epk, 32),
    )
    const wrapKey = hkdf(sha256, shared, undefined, WRAP_INFO, 32)
    const messageKey = xchacha20poly1305(wrapKey, wrapNonce).decrypt(blob.subarray(24))
    const plaintext = xchacha20poly1305(messageKey, bytes(envelope.n, 24)).decrypt(ciphertext)
    return parseBody(plaintext)
  } catch {
    throw new E2eeError('corrupt')
  }
}
