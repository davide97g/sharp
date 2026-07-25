// Channel teardown shared by `channel.deleted`, leaving, and losing access.
//
// Every cached slice keyed by channel id has to be dropped together, or a later
// `channel.created` for the same id resurrects stale messages, docs and unread counts.
// Add new per-channel caches to `dropChannel` when you add them to the store.

import { navigateTo } from '../nav'
import type { State } from '../../store'
import type { Setter } from './messageHelpers'

/** Remove a channel and all its cached state; navigate home if it was open. */
export function dropChannel(set: Setter, get: () => State, id: string) {
  const wasCurrent = get().currentChannelId === id
  set((s) => {
    const members = { ...s.members }
    delete members[id]
    const byChannel = { ...s.byChannel }
    delete byChannel[id]
    const docsByChannel = { ...s.docsByChannel }
    delete docsByChannel[id]
    const trashByChannel = { ...s.trashByChannel }
    delete trashByChannel[id]
    const channelVoiceTriggers = { ...s.channelVoiceTriggers }
    delete channelVoiceTriggers[id]
    return {
      channels: s.channels.filter((c) => c.id !== id),
      members,
      byChannel,
      docsByChannel,
      trashByChannel,
      channelVoiceTriggers,
    }
  })
  if (wasCurrent) navigateTo('/')
}
