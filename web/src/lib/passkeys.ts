import { api } from './api'

function decodeBase64Url(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function encodeBase64Url(value: ArrayBuffer | null): string | null {
  if (!value) return null
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function creationOptions(raw: unknown): PublicKeyCredentialCreationOptions {
  const options = structuredClone(raw) as any
  options.challenge = decodeBase64Url(options.challenge) as never
  options.user.id = decodeBase64Url(options.user.id) as never
  if (options.excludeCredentials) {
    options.excludeCredentials = options.excludeCredentials.map((credential: any) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    }))
  }
  return options as unknown as PublicKeyCredentialCreationOptions
}

function requestOptions(raw: unknown): PublicKeyCredentialRequestOptions {
  const options = structuredClone(raw) as any
  options.challenge = decodeBase64Url(options.challenge) as never
  if (options.allowCredentials) {
    options.allowCredentials = options.allowCredentials.map((credential: any) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    }))
  }
  return options as unknown as PublicKeyCredentialRequestOptions
}

function registrationJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      attestationObject: encodeBase64Url(response.attestationObject),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      transports: typeof response.getTransports === 'function' ? response.getTransports() : [],
    },
    extensions: credential.getClientExtensionResults(),
  }
}

function authenticationJSON(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      authenticatorData: encodeBase64Url(response.authenticatorData),
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      signature: encodeBase64Url(response.signature),
      userHandle: encodeBase64Url(response.userHandle),
    },
    extensions: credential.getClientExtensionResults(),
  }
}

export function supportsPasskeys(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window
}

export async function loginWithPasskey() {
  if (!supportsPasskeys()) throw new Error('Passkeys require a supported browser and HTTPS.')
  const challenge = await api.passkeyLoginStart()
  const credential = (await navigator.credentials.get({
    publicKey: requestOptions(challenge.options.publicKey),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey sign-in was cancelled.')
  return api.passkeyLoginFinish(challenge.ceremony_id, authenticationJSON(credential))
}

export async function registerPasskey(name: string, password: string) {
  if (!supportsPasskeys()) throw new Error('Passkeys require a supported browser and HTTPS.')
  const challenge = await api.passkeyRegisterStart(name, password)
  const credential = (await navigator.credentials.create({
    publicKey: creationOptions(challenge.options.publicKey),
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Passkey setup was cancelled.')
  return api.passkeyRegisterFinish(challenge.ceremony_id, registrationJSON(credential))
}

export function isPasskeyCancellation(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')
}
