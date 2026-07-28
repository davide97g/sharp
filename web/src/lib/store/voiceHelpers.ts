// Pure projections from voice WS payloads into store shape.
//
// Contract: docs/arch/04-voice.md.
//
// The server is authoritative for room state: these functions only reshape a snapshot,
// never merge optimistically. A local guess that disagrees with the next snapshot shows a
// participant who is not there.

import type { Poll, VoiceParticipant, VoiceRoomSnapshot } from '../types'
import { KEYS, readLocalBool, writeLocalBool } from '../localPrefs'
import { loadVideoBackground } from '../videoBackgrounds'
import type { VoiceRoom, VoiceState } from '../../store'

/** The one place a wire participant becomes a room entry — snapshots and the
 *  joined/updated events all go through it, so a new field is added once. */
export function voiceRoomEntry(participant: VoiceParticipant): VoiceRoom[string] {
  return {
    user_id: participant.user_id,
    display_name: participant.display_name,
    annotation_color: participant.annotation_color,
    guest: participant.guest,
    muted: participant.muted,
    transcribing: participant.transcribing,
    camera_on: participant.camera_on,
    screen_on: participant.screen_on,
    screen_stream_id: participant.screen_stream_id,
    hand_raised: participant.hand_raised,
    hand_raised_at: participant.hand_raised_at,
    aura_style: participant.aura_style,
    garden_active: participant.garden_active,
    pos_x: participant.pos_x,
    pos_y: participant.pos_y,
    joined_at: participant.joined_at,
  }
}

export function voiceRoomFromParticipants(
  participants: VoiceRoomSnapshot['participants'],
): VoiceRoom {
  const room: VoiceRoom = {}
  for (const participant of participants) {
    room[participant.conn_id] = voiceRoomEntry(participant)
  }
  return room
}

export function activeMeetingsFromSnapshots(snapshots: VoiceRoomSnapshot[]): Record<string, string> {
  const meetings: Record<string, string> = {}
  for (const snapshot of snapshots) {
    if (snapshot.active_meeting_id) meetings[snapshot.channel_id] = snapshot.active_meeting_id
  }
  return meetings
}

export function voiceRoomsFromSnapshots(snapshots: VoiceRoomSnapshot[]): Record<string, VoiceRoom> {
  const rooms: Record<string, VoiceRoom> = {}
  for (const snapshot of snapshots) {
    rooms[snapshot.channel_id] = voiceRoomFromParticipants(snapshot.participants)
  }
  return rooms
}

export function withPollVotes(
  poll: Poll,
  optionIds: string[],
  userId: string,
  displayName: string,
): Poll {
  const selected = new Set(optionIds)
  const options = poll.options.map((option) => {
    const voters = option.voters.filter((voter) => voter.id !== userId)
    if (selected.has(option.id)) voters.push({ id: userId, display_name: displayName })
    return { ...option, voters, count: voters.length }
  })
  const voterIds = new Set<string>()
  for (const option of options) {
    for (const voter of option.voters) voterIds.add(voter.id)
  }
  return { ...poll, options, my_votes: [...selected], total_voters: voterIds.size }
}

export function voiceErrorMessage(code: string): string {
  switch (code) {
    case 'room_full':
      return 'This voice room is full.'
    case 'not_member':
      return 'You do not have access to this call.'
    case 'not_in_room':
      return 'You are no longer in this voice room.'
    case 'camera_full':
      return 'Sixteen cameras are already active. You are still connected by audio.'
    case 'screen_taken':
      return 'Someone else is already sharing their screen.'
    case 'link_revoked':
      return 'This call link is no longer valid.'
    case 'media_unavailable':
      return 'Call media is unavailable. Check the LiveKit service, then rejoin.'
    default:
      return `Voice error: ${code}`
  }
}

// Device-local, not synced: denoising depends on the mic you are actually using.
export function saveNoiseSuppression(enabled: boolean) {
  writeLocalBool(KEYS.noiseSuppression, enabled)
}

// Defaults to on: denoising is what most people want, and an unreadable store should
// not silently turn it off.
export function storedNoiseSuppression(): boolean {
  return readLocalBool(KEYS.noiseSuppression, true)
}

// Spatial view is a per-device choice through and through: the floor plan, the panning,
// and (since positions became local overrides) the layout itself. It lives next to the
// other device-local call prefs. Off by default — plain stereo is what people expect
// when they join a call. The positions themselves are not persisted: an arrangement
// belongs to the call you built it in.
export function saveVoiceSpatial(enabled: boolean) {
  writeLocalBool(KEYS.voiceSpatial, enabled)
}

export function storedVoiceSpatial(): boolean {
  return readLocalBool(KEYS.voiceSpatial, false)
}

// Push to talk belongs to the microphone, which belongs to the device: the laptop you
// take to a shared office wants it on, the one in your study does not. Off by default.
export function saveVoicePushToTalk(enabled: boolean) {
  writeLocalBool(KEYS.voicePushToTalk, enabled)
}

export function storedVoicePushToTalk(): boolean {
  return readLocalBool(KEYS.voicePushToTalk, false)
}

/** The idle voice slice — also the reset applied on every leave/kick/error path. */
export function emptyVoiceState(): VoiceState {
  const videoBackground = loadVideoBackground()
  return {
    channelId: null,
    status: 'idle',
    muted: false,
    pushToTalk: storedVoicePushToTalk(),
    pushToTalkHeld: false,
    locallyMutedUsers: new Set(),
    noiseSuppression: storedNoiseSuppression(),
    noiseSuppressionAvailable: true,
    videoBackground,
    handRaised: false,
    transcribing: false,
    transcriptionAvailable: false,
    roastArmed: false,
    speaking: {},
    cameraStatus: 'off',
    screenStatus: 'off',
    stageMode: 'expanded',
    spatial: storedVoiceSpatial(),
    spatialPositions: {},
    spatialOverShare: false,
    audioDeviceId: null,
    videoDeviceId: null,
    localStream: null,
    remoteStreams: {},
    localScreenStream: null,
    remoteScreenStreams: {},
    client: null,
    annotationsAllowed: false,
    annotating: false,
  }
}
