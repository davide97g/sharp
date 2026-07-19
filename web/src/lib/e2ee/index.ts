import type { Channel, E2eeDevice, EncryptedAttachment, EncryptedBody, Message } from '../types'
import { useStore } from '../../store'
import { getDevices, invalidateDevices, type Device } from './devices'
import { E2eeError, openMessage, sealMessage } from './envelope'
import {
  deleteLocalDevice,
  deviceSetHash,
  ensureDevice,
  fingerprint,
  fingerprintDeviceSets,
  getLocalDevice,
  type LocalDevice,
} from './keys'

export {
  E2eeError,
  ensureDevice,
  deleteLocalDevice,
  deviceSetHash,
  fingerprint,
  fingerprintDeviceSets,
  getDevices,
  getLocalDevice,
  invalidateDevices,
  openMessage,
  sealMessage,
}
export type { Device, LocalDevice }

export function isChannelEncrypted(channel: Channel, partnerDevices: E2eeDevice[]): boolean {
  return channel.kind === 'dm' && partnerDevices.length > 0
}

export async function encryptDmMessage(
  channelId: string,
  text: string,
  attachments?: EncryptedAttachment[],
): Promise<string> {
  const state = useStore.getState()
  const channel = state.channels.find((item) => item.id === channelId)
  const me = state.me
  const partner = channel?.dm_user
  if (!channel || channel.kind !== 'dm' || !me || !partner) {
    throw new E2eeError('no_key')
  }
  const sender = (await getLocalDevice()) ?? (await ensureDevice())
  const [myDevices, partnerDevices] = await Promise.all([
    getDevices(me.id),
    getDevices(partner.id),
  ])
  if (!myDevices.length || !partnerDevices.length) throw new E2eeError('no_key')
  const recipients = [
    ...new Map([...myDevices, ...partnerDevices].map((device) => [device.id, device])).values(),
  ]
  return sealMessage({ text, ...(attachments?.length ? { attachments } : {}) }, recipients, sender)
}

export async function decryptDmMessage(message: Message): Promise<EncryptedBody> {
  if (!message.encrypted) return { text: message.content }
  return openMessage(message.content, async (deviceId) => {
    const devices = await getDevices(message.user.id)
    return devices.find((device) => device.id === deviceId) ?? null
  })
}
