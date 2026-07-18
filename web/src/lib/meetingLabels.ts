import type { Channel, MeetingListItem } from './types'

type MeetingRef = Pick<MeetingListItem, 'channel_id' | 'channel_kind' | 'channel_name' | 'title'>

/** Hidden server-generated DM channel name: `dm:<uuid>:<uuid>`. */
const RAW_DM_NAME = /^dm:[0-9a-f-]{36}:[0-9a-f-]{36}$/i

function dmPeerName(meeting: MeetingRef, channels: Channel[]): string | null {
  const channel = channels.find((c) => c.id === meeting.channel_id)
  return channel?.dm_user?.display_name ?? null
}

/** Where the meeting happened, viewer-friendly: `#channel`, `DM · name`, or the meet title. */
export function meetingChannelLabel(meeting: MeetingRef, channels: Channel[]): string {
  if (meeting.channel_kind === 'standalone') return 'Standalone meet'
  if (meeting.channel_kind === 'dm') {
    const peer = dmPeerName(meeting, channels)
    return peer ? `DM · ${peer}` : 'Direct message'
  }
  return `#${meeting.channel_name}`
}

/**
 * Meeting title with the raw `dm:<uuid>:<uuid>` prefix (used by older
 * server-generated titles) replaced by a human-readable DM label.
 */
export function meetingDisplayTitle(meeting: MeetingRef, channels: Channel[]): string {
  if (meeting.channel_kind !== 'dm') return meeting.title
  if (!RAW_DM_NAME.test(meeting.channel_name) || !meeting.title.startsWith(meeting.channel_name)) {
    return meeting.title
  }
  const rest = meeting.title.slice(meeting.channel_name.length)
  const peer = dmPeerName(meeting, channels)
  return `${peer ? `DM with ${peer}` : 'Direct message'}${rest}`
}
