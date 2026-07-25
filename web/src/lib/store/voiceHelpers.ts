// Pure projections from voice WS payloads into store shape.
//
// Contract: docs/arch/04-voice.md.
//
// The server is authoritative for room state: these functions only reshape a snapshot,
// never merge optimistically. A local guess that disagrees with the next snapshot shows a
// participant who is not there.

import type { Poll, VoiceRoomSnapshot } from '../types'
import { loadVideoBackground } from '../videoBackgrounds'
import type { VoiceRoom, VoiceState } from '../../store'

export function voiceRoomFromParticipants(
  participants: VoiceRoomSnapshot['participants'],
): VoiceRoom {
  const room: VoiceRoom = {}
  for (const participant of participants) {
    room[participant.conn_id] = {
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
      joined_at: participant.joined_at,
    }
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
const NOISE_SUPPRESSION_KEY = 'sharp.noiseSuppression'

export function saveNoiseSuppression(enabled: boolean) {
  try {
    window.localStorage.setItem(NOISE_SUPPRESSION_KEY, enabled ? '1' : '0')
  } catch {
    // ignore persistence failures (private mode etc.)
  }
}

export function storedNoiseSuppression(): boolean {
  try {
    return window.localStorage.getItem(NOISE_SUPPRESSION_KEY) !== '0'
  } catch {
    return true
  }
}

/** The idle voice slice — also the reset applied on every leave/kick/error path. */
export function emptyVoiceState(): VoiceState {
  const videoBackground = loadVideoBackground()
  return {
    channelId: null,
    status: 'idle',
    muted: false,
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
