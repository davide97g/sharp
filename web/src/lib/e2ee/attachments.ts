import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import type { Attachment, EncryptedAttachment } from '../types'

export const MAX_ENCRYPTED_FILE_BYTES = 50 * 1024 * 1024

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(base64)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function encryptAttachmentFile(
  file: File,
): Promise<{ file: File; metadata: Omit<EncryptedAttachment, 'id'> }> {
  if (file.size > MAX_ENCRYPTED_FILE_BYTES) {
    throw new Error('Encrypted attachments are limited to 50 MB because encryption happens in memory.')
  }
  const key = randomBytes(32)
  const nonce = randomBytes(24)
  const plaintext = new Uint8Array(await file.arrayBuffer())
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext)
  return {
    file: new File([ciphertext], 'encrypted.bin', { type: 'application/octet-stream' }),
    metadata: {
      key: toBase64Url(key),
      nonce: toBase64Url(nonce),
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
    },
  }
}

export function resolveEncryptedAttachments(
  wire: Attachment[],
  metadata: EncryptedAttachment[] | undefined,
): Attachment[] {
  if (!metadata?.length) return wire
  const byId = new Map(metadata.map((item) => [item.id, item]))
  return wire.map((attachment) => {
    const real = byId.get(attachment.id)
    return real
      ? {
          ...attachment,
          filename: real.filename,
          content_type: real.content_type,
          decryption: { key: real.key, nonce: real.nonce },
        }
      : attachment
  })
}

export async function decryptAttachmentBlob(ciphertext: Blob, attachment: Attachment): Promise<Blob> {
  if (!attachment.decryption) throw new Error('No decryption key for this attachment')
  try {
    const plaintext = xchacha20poly1305(
      fromBase64Url(attachment.decryption.key),
      fromBase64Url(attachment.decryption.nonce),
    ).decrypt(new Uint8Array(await ciphertext.arrayBuffer()))
    return new Blob([plaintext], { type: attachment.content_type })
  } catch {
    throw new Error('Could not decrypt attachment')
  }
}
