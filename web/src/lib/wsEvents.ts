// The WebSocket event reducer: one `case` per server -> client event.
//
// Contract: the event lists in docs/arch/*.md. **This switch and the server's emitters in
// server/src/ws/ are two halves of one contract** — an event the server sends and this
// file ignores is silently dropped, and there is no reconciliation poll to recover from
// it, so the UI stays stale until reload. When you add an event, change all three: the
// server emitter, this switch, and the arch doc.
//
// It stays one flat switch on purpose: the full set of realtime events the client
// understands is greppable in one place. Reducers that need real logic live in
// lib/store/*Helpers.ts and are called from here.
//
// This is a plain function rather than a store action so store.ts holds state and actions
// only; the store exposes it as `applyWsEvent` and passes its own `set`/`get`.

import { api } from './api'
import { annotations } from './annotations'
import { gifPreviewText } from './gif'
import { navigateTo } from './nav'
import { notificationPath } from './types'
import {
  playHuddleRingSound,
  playNotifySound,
  playVoiceJoinSound,
  playVoiceLeaveSound,
  sound,
} from './sound'
import { navigateToChannel, showOsNotification } from './notify'
import { toastError, toastInfo, toastNotify } from './toast'
import { invalidateDevices } from './e2ee'
import { markAllDeviceSetsChanged, markDeviceSetChanged } from './e2ee/trust'
import { removeIndexedMessage } from './e2ee/search'
import { normalizeUiPrefs, writeLocalUiPrefs } from './uiPrefs'
import { confettiAt } from './celebrate'
import { upsertMeetingItem } from './store/calendarHelpers'
import { dropChannel } from './store/channelHelpers'
import { applyDocDeleted, countUnread, placeDoc } from './store/docHelpers'
import {
  applyDuckStreak,
  applyMessageCreated,
  applyMessageDeleted,
  applyMessageUpdated,
  queueDecryptions,
  type Setter,
} from './store/messageHelpers'
import {
  activeMeetingsFromSnapshots,
  emptyVoiceState,
  voiceErrorMessage,
  voiceRoomEntry,
  voiceRoomFromParticipants,
  voiceRoomsFromSnapshots,
} from './store/voiceHelpers'
import {
  dndActive,
  streamChannelShielded,
  streamShieldOn,
  streamShieldsChannel,
} from './store/predicates'
import { stopVoiceRecognizer } from './store/recognizer'
import { sortTasks } from './store/taskHelpers'
import { applyUi } from './store/uiHelpers'
import type {
  CalendarMeetingCancelledPayload,
  CalendarMeetingCreatedPayload,
  CalendarMeetingUpdatedPayload,
  CalendarReminderPayload,
  CalendarSyncedPayload,
  ChannelCreatedPayload,
  ChannelDeletedPayload,
  ChannelMemberPayload,
  ChannelMemberUpdatedPayload,
  ChannelUpdatedPayload,
  DocCreatedPayload,
  DocDeletedPayload,
  DocMentionPayload,
  DocUpdatedPayload,
  DuckStreakPayload,
  E2eeDevicesChangedPayload,
  HelloPayload,
  MeetingEndedPayload,
  MeetingStartedPayload,
  MessageCreatedPayload,
  MessageDeletedPayload,
  MessageUpdatedPayload,
  NotificationCreatedPayload,
  PollCreatedPayload,
  PollDeletedPayload,
  PollUpdatedPayload,
  PresencePayload,
  ProjectCreatedPayload,
  ProjectUpdatedPayload,
  ReactionPayload,
  TaskCommentPayload,
  TaskCreatedPayload,
  TaskDeletedPayload,
  TaskUpdatedPayload,
  TypingPayload,
  UserUpdatedPayload,
  VoiceAnnotateClearPayload,
  VoiceAnnotatePayload,
  VoiceAnnotateStatePayload,
  VoiceErrorPayload,
  VoiceParticipantJoinedPayload,
  VoiceParticipantLeftPayload,
  VoiceParticipantMovedPayload,
  VoiceParticipantUpdatedPayload,
  VoicePollStatePayload,
  VoiceStatePayload,
  VoiceTriggerCreatedPayload,
  VoiceTriggerDeletedPayload,
  VoiceTriggerFiredPayload,
} from './types'
import type { State } from '../store'
import type { WsEnvelope } from './ws'

/** Apply one server event to the store. `set`/`get` come from the store itself. */
export function applyWsEventTo(env: WsEnvelope, set: Setter, get: () => State) {
    const me = get().me
    switch (env.type) {
      case 'hello': {
        const p = env.payload as HelloPayload
        const previous = get()
        const voiceReconnected =
          previous.myConnId !== null &&
          previous.myConnId !== p.conn_id &&
          previous.voice.channelId !== null
        if (voiceReconnected) {
          stopVoiceRecognizer()
          previous.voice.client?.stop()
          annotations.reset()
          annotations.setSend(null, null)
        }
        set({
          online: new Set(p.online_user_ids),
          myConnId: p.conn_id,
          voiceRooms: voiceRoomsFromSnapshots(p.voice_rooms),
          activeMeetings: activeMeetingsFromSnapshots(p.voice_rooms),
          callPoll:
            p.voice_rooms.find(
              (room) => room.channel_id === (previous.voice.channelId ?? previous.guestChannelId),
            )?.poll ?? null,
          ...(voiceReconnected ? { voice: emptyVoiceState() } : {}),
        })
        // Guest bootstrap: once we have a conn id, auto-join the bound channel's
        // voice room exactly once (joinVoice fetches /voice/config with the guest
        // token). Reconnects don't re-fire this; the guest page offers Rejoin.
        const st = get()
        if (st.isGuest && st.guestPendingJoin && st.guestChannelId) {
          set({ guestPendingJoin: false })
          void get().joinVoice(st.guestChannelId)
        }
        break
      }
      case 'presence': {
        const p = env.payload as PresencePayload
        set((s) => {
          const online = new Set(s.online)
          if (p.status === 'online') online.add(p.user_id)
          else online.delete(p.user_id)
          return { online }
        })
        break
      }
      case 'e2ee.devices_changed': {
        const p = env.payload as E2eeDevicesChangedPayload
        invalidateDevices(p.user_id)
        if (p.user_id === me?.id) void markAllDeviceSetsChanged()
        else void markDeviceSetChanged(p.user_id)
        void get().refreshDmEncryption(p.user_id)
        break
      }
      case 'typing': {
        const p = env.payload as TypingPayload
        if (me && p.user_id === me.id) break
        set((s) => ({
          typing: {
            ...s.typing,
            [p.channel_id]: {
              ...(s.typing[p.channel_id] ?? {}),
              [p.user_id]: { display_name: p.display_name, expiresAt: Date.now() + 3000 },
            },
          },
        }))
        break
      }
      case 'voice.state': {
        const p = env.payload as VoiceStatePayload
        const joiningThisRoom =
          get().voice.channelId === p.channel_id && get().voice.status === 'connecting'
        set((s) => ({
          voiceRooms: {
            ...s.voiceRooms,
            [p.channel_id]: voiceRoomFromParticipants(p.participants),
          },
          activeMeetings: p.active_meeting_id
            ? { ...s.activeMeetings, [p.channel_id]: p.active_meeting_id }
            : s.activeMeetings,
          callPoll: p.poll,
          ...(s.voice.channelId === p.channel_id
            ? {
                voice: {
                  ...s.voice,
                  speaking: {},
                  annotationsAllowed: p.annotations_allowed,
                },
              }
            : {}),
        }))
        const active = get().voice
        if (active.channelId === p.channel_id) {
          active.client?.syncPeers(p.participants)
          for (const participant of p.participants) {
            if (participant.conn_id === get().myConnId) continue
            active.client?.updateRemoteScreen(
              participant.conn_id,
              participant.screen_on ? participant.screen_stream_id : null,
            )
          }
        }
        if (joiningThisRoom) void get().connectVoiceMedia(p)
        break
      }
      case 'voice.participant_joined': {
        const p = env.payload as VoiceParticipantJoinedPayload
        const previousRoom = get().voiceRooms[p.channel_id]
        const huddleStarted = !previousRoom || Object.keys(previousRoom).length === 0
        set((s) => ({
          voiceRooms: {
            ...s.voiceRooms,
            [p.channel_id]: {
              ...(s.voiceRooms[p.channel_id] ?? {}),
              [p.participant.conn_id]: voiceRoomEntry(p.participant),
            },
          },
        }))
        const active = get().voice
        if (active.channelId === p.channel_id) {
          active.client?.ensurePeer(p.participant.conn_id, p.participant.user_id)
          if (p.participant.conn_id !== get().myConnId && p.participant.screen_on) {
            active.client?.updateRemoteScreen(
              p.participant.conn_id,
              p.participant.screen_stream_id,
            )
          }
          if (p.participant.conn_id !== get().myConnId && p.participant.user_id !== me?.id) {
            playVoiceJoinSound()
          }
        } else {
          const channel = get().channels.find((candidate) => candidate.id === p.channel_id)
          if (
            huddleStarted &&
            channel?.kind === 'dm' &&
            me &&
            p.participant.user_id !== me.id &&
            !streamShieldOn(get())
          ) {
            const who = channel.dm_user?.display_name ?? 'Someone'
            toastNotify('started a huddle', {
              title: who,
              initial: who.trim().charAt(0).toUpperCase() || '?',
              onClick: () => {
                navigateToChannel(channel.id)
                // Mic only — no camera; mini widget keeps it audio-first.
                void get().joinVoice(channel.id, { stageMode: 'mini' })
              },
            })
            playHuddleRingSound()
          }
        }
        break
      }
      case 'voice.participant_left': {
        const p = env.payload as VoiceParticipantLeftPayload
        const activeBeforeLeave = get().voice
        set((s) => {
          const room = { ...(s.voiceRooms[p.channel_id] ?? {}) }
          delete room[p.conn_id]
          const voiceRooms = { ...s.voiceRooms }
          if (Object.keys(room).length === 0) delete voiceRooms[p.channel_id]
          else voiceRooms[p.channel_id] = room
          return { voiceRooms }
        })
        if (activeBeforeLeave.channelId === p.channel_id) {
          playVoiceLeaveSound()
          if (p.conn_id === get().myConnId) {
            stopVoiceRecognizer()
            activeBeforeLeave.client?.stop()
            annotations.reset()
            annotations.setSend(null, null)
            set({ voice: emptyVoiceState(), callPoll: null })
          } else {
            annotations.clearConn(p.conn_id)
            activeBeforeLeave.client?.removePeer(p.conn_id)
            set((s) => {
              if (s.voice.client !== activeBeforeLeave.client) return {}
              const remoteScreenStreams = { ...s.voice.remoteScreenStreams }
              delete remoteScreenStreams[p.conn_id]
              return { voice: { ...s.voice, remoteScreenStreams } }
            })
          }
        }
        break
      }
      case 'voice.participant_moved': {
        const p = env.payload as VoiceParticipantMovedPayload
        set((s) => {
          const room = s.voiceRooms[p.channel_id]
          const entry = room?.[p.conn_id]
          if (!entry) return {}
          return {
            voiceRooms: {
              ...s.voiceRooms,
              [p.channel_id]: { ...room, [p.conn_id]: { ...entry, pos_x: p.x, pos_y: p.y } },
            },
          }
        })
        break
      }
      case 'voice.participant_updated': {
        const p = env.payload as VoiceParticipantUpdatedPayload
        // Detect a false→true hand-raise transition for another participant (never
        // our own). Comparing the stored flag against the incoming one dedupes:
        // repeated updates while already raised won't re-fire.
        const prevEntry = get().voiceRooms[p.channel_id]?.[p.participant.conn_id]
        const handJustRaised =
          p.participant.hand_raised &&
          !prevEntry?.hand_raised &&
          p.participant.conn_id !== get().myConnId
        set((s) => {
          const room = s.voiceRooms[p.channel_id]
          if (!room || !room[p.participant.conn_id]) return {}
          return {
            voiceRooms: {
              ...s.voiceRooms,
              [p.channel_id]: {
                ...room,
                [p.participant.conn_id]: voiceRoomEntry(p.participant),
              },
            },
          }
        })

        const active = get().voice
        if (active.channelId !== p.channel_id) break
        if (handJustRaised) {
          sound.handRaise()
          const name =
            get().users[p.participant.user_id]?.display_name ??
            p.participant.display_name ??
            'Someone'
          toastInfo(`${name} raised their hand`)
        }
        if (p.participant.conn_id === get().myConnId) {
          // camera
          if (p.participant.camera_on && active.cameraStatus === 'starting' && active.client) {
            const client = active.client
            void client.startCamera().catch((error) => {
              if (get().voice.client !== client) return
              client.stopCamera()
              get().ws?.send('voice.camera', { channel_id: p.channel_id, enabled: false })
              set((s) => ({ voice: { ...s.voice, cameraStatus: 'off', localStream: null } }))
              toastError(error instanceof Error ? error.message : 'Could not start the camera.')
            })
          } else if (!p.participant.camera_on) {
            active.client?.stopCamera()
            set((s) => ({
              voice: { ...s.voice, cameraStatus: 'off', localStream: null },
            }))
          }
          // screen — publish only once the server echoes our own enable.
          if (p.participant.screen_on && active.screenStatus === 'starting' && active.client) {
            active.client.publishScreen()
          } else if (!p.participant.screen_on && active.screenStatus !== 'off') {
            active.client?.stopScreenShare()
            set((s) => ({
              voice: { ...s.voice, screenStatus: 'off', localScreenStream: null },
            }))
          }
        } else {
          if (!p.participant.camera_on) {
            set((s) => {
              const remoteStreams = { ...s.voice.remoteStreams }
              delete remoteStreams[p.participant.conn_id]
              return { voice: { ...s.voice, remoteStreams } }
            })
          }
          active.client?.updateRemoteScreen(
            p.participant.conn_id,
            p.participant.screen_on ? p.participant.screen_stream_id : null,
          )
        }
        break
      }
      case 'meeting.started': {
        const p = env.payload as MeetingStartedPayload
        set((s) => ({ activeMeetings: { ...s.activeMeetings, [p.channel_id]: p.meeting_id } }))
        break
      }
      case 'meeting.ended': {
        const p = env.payload as MeetingEndedPayload
        set((s) => {
          const activeMeetings = { ...s.activeMeetings }
          delete activeMeetings[p.channel_id]
          return { activeMeetings }
        })
        window.dispatchEvent(new CustomEvent('sharp:meeting-updated', { detail: p }))
        break
      }
      case 'meeting.phrase':
      case 'meeting.summary_ready': {
        const p = env.payload as { meeting_id: string; channel_id: string }
        window.dispatchEvent(new CustomEvent('sharp:meeting-updated', { detail: p }))
        break
      }
      case 'voice.roast_armed': {
        const p = env.payload as { channel_id: string; armed: boolean }
        set((s) =>
          s.voice.channelId === p.channel_id
            ? { voice: { ...s.voice, roastArmed: p.armed } }
            : {},
        )
        break
      }
      case 'voice.trigger_fired': {
        const p = env.payload as VoiceTriggerFiredPayload
        if (get().voice.channelId === p.channel_id) {
          toastInfo(`🎙️ ${p.display_name} triggered “${p.phrase}”`)
        }
        break
      }
      case 'voice.annotate': {
        const p = env.payload as VoiceAnnotatePayload
        if (get().voice.channelId === p.channel_id) annotations.applyRemote(p)
        break
      }
      case 'voice.annotate_clear': {
        const p = env.payload as VoiceAnnotateClearPayload
        if (get().voice.channelId === p.channel_id) annotations.clearAll()
        break
      }
      case 'voice.annotate_state': {
        const p = env.payload as VoiceAnnotateStatePayload
        if (get().voice.channelId !== p.channel_id) break
        set((s) => {
          const room = s.voiceRooms[p.channel_id]
          const iAmSharer = s.myConnId ? room?.[s.myConnId]?.screen_on ?? false : false
          return {
            voice: {
              ...s.voice,
              annotationsAllowed: p.allowed,
              // Drop the pen when drawing is revoked for non-sharers.
              annotating: !p.allowed && !iAmSharer ? false : s.voice.annotating,
            },
          }
        })
        break
      }
      case 'voice.error': {
        const p = env.payload as VoiceErrorPayload
        if (p.code === 'annotate_denied') {
          // Non-fatal: server refused a draw/allow/clear. Stay in the call; just
          // drop the pen so the UI reflects that drawing isn't permitted.
          set((s) => ({ voice: { ...s.voice, annotating: false } }))
          break
        }
        if (p.code === 'camera_full') {
          set((s) => ({ voice: { ...s.voice, cameraStatus: 'off', localStream: null } }))
          toastError(voiceErrorMessage(p.code))
          break
        }
        if (p.code === 'screen_taken') {
          // Non-fatal: discard the acquired-but-unpublished share and stay in the call.
          get().voice.client?.stopScreenShare()
          set((s) => ({ voice: { ...s.voice, screenStatus: 'off', localScreenStream: null } }))
          toastError(voiceErrorMessage(p.code))
          break
        }
        if (p.code === 'link_revoked') {
          // The guest's call link was regenerated — non-recoverable for this
          // token. Tear the call down and mark the guest session revoked so the
          // guest page shows the invalid-link state instead of Rejoin.
          stopVoiceRecognizer()
          get().voice.client?.stop()
          annotations.reset()
          annotations.setSend(null, null)
          set({
            voice: emptyVoiceState(),
            callPoll: null,
            guestRevoked: true,
            guestPendingJoin: false,
          })
          toastError(voiceErrorMessage(p.code))
          break
        }
        stopVoiceRecognizer()
        get().voice.client?.stop()
        annotations.reset()
        annotations.setSend(null, null)
        set({ voice: emptyVoiceState(), callPoll: null })
        toastError(voiceErrorMessage(p.code))
        break
      }
      case 'message.created': {
        const { message, duck_streak } = env.payload as MessageCreatedPayload
        applyMessageCreated(set, message, me?.id ?? null, duck_streak)
        queueDecryptions(set, [message])
        // Ultra-soft cue when a top-level message lands in the channel you're
        // looking at (others' messages only — DM/mention/reply get the fuller
        // notification chime via notification.created instead).
        const focusedHere =
          typeof document !== 'undefined' &&
          document.hasFocus() &&
          get().currentChannelId === message.channel_id
        if (focusedHere && !message.parent_id && message.user.id !== me?.id) {
          sound.messageReceived()
        }
        break
      }
      case 'duck.streak': {
        const { channel_id, duck_streak } = env.payload as DuckStreakPayload
        applyDuckStreak(set, channel_id, duck_streak)
        break
      }
      case 'voice_trigger.created': {
        const p = env.payload as VoiceTriggerCreatedPayload
        set((s) => {
          const current = s.channelVoiceTriggers[p.channel_id]
          if (!current || current.some((trigger) => trigger.id === p.trigger.id)) return {}
          return {
            channelVoiceTriggers: {
              ...s.channelVoiceTriggers,
              [p.channel_id]: [...current, p.trigger],
            },
          }
        })
        break
      }
      case 'voice_trigger.deleted': {
        const p = env.payload as VoiceTriggerDeletedPayload
        set((s) => {
          const current = s.channelVoiceTriggers[p.channel_id]
          if (!current) return {}
          return {
            channelVoiceTriggers: {
              ...s.channelVoiceTriggers,
              [p.channel_id]: current.filter((trigger) => trigger.id !== p.trigger_id),
            },
          }
        })
        break
      }
      case 'message.updated': {
        const { message } = env.payload as MessageUpdatedPayload
        applyMessageUpdated(set, message)
        queueDecryptions(set, [message])
        break
      }
      case 'message.deleted': {
        const p = env.payload as MessageDeletedPayload
        applyMessageDeleted(set, p)
        void removeIndexedMessage(p.message_id)
        break
      }
      case 'reaction.added': {
        const p = env.payload as ReactionPayload
        get().applyReaction(p.message_id, p.channel_id, p.emoji, p.user_id, true)
        break
      }
      case 'reaction.removed': {
        const p = env.payload as ReactionPayload
        get().applyReaction(p.message_id, p.channel_id, p.emoji, p.user_id, false)
        break
      }
      case 'user.updated': {
        const { user } = env.payload as UserUpdatedPayload
        set((s) => ({
          users: { ...s.users, [user.id]: user },
          // The broadcast redacts email; merge so we keep our own address.
          me: s.me?.id === user.id ? { ...s.me, ...user } : s.me,
        }))
        break
      }
      case 'channel.created': {
        const { channel } = env.payload as ChannelCreatedPayload
        set((s) => ({
          channels: s.channels.some((c) => c.id === channel.id)
            ? s.channels.map((c) => (c.id === channel.id ? channel : c))
            : [...s.channels, channel],
        }))
        if (channel.kind === 'dm') void get().refreshDmEncryption(channel.dm_user?.id)
        break
      }
      case 'channel.updated': {
        const { channel } = env.payload as ChannelUpdatedPayload
        // Merge only mutable metadata so each viewer keeps their own
        // unread_count / is_member / last_message_at / dm_user.
        set((s) => ({
          channels: s.channels.some((c) => c.id === channel.id)
            ? s.channels.map((c) =>
                c.id === channel.id
                  ? { ...c, name: channel.name, topic: channel.topic, kind: channel.kind }
                  : c,
              )
            : [...s.channels, channel],
        }))
        break
      }
      case 'channel.deleted': {
        const { channel_id } = env.payload as ChannelDeletedPayload
        dropChannel(set, get, channel_id)
        break
      }
      case 'channel.member_joined': {
        const p = env.payload as ChannelMemberPayload
        set((s) => {
          const members = s.members[p.channel_id]
          const users = { ...s.users, [p.user.id]: p.user }
          let channels = s.channels
          if (me && p.user.id === me.id) {
            channels = s.channels.map((c) =>
              c.id === p.channel_id ? { ...c, is_member: true, my_role: p.role } : c,
            )
          }
          return {
            users,
            channels,
            members: members
              ? {
                  ...s.members,
                  [p.channel_id]: members.some((m) => m.id === p.user.id)
                    ? members.map((member) =>
                        member.id === p.user.id ? { ...p.user, role: p.role } : member,
                      )
                    : [...members, { ...p.user, role: p.role }],
                }
              : s.members,
          }
        })
        break
      }
      case 'channel.member_left': {
        const p = env.payload as ChannelMemberPayload
        set((s) => {
          const members = s.members[p.channel_id]
          let channels = s.channels
          if (me && p.user.id === me.id) {
            channels = s.channels.map((c) =>
              c.id === p.channel_id ? { ...c, is_member: false, my_role: null } : c,
            )
          }
          return {
            channels,
            members: members
              ? { ...s.members, [p.channel_id]: members.filter((m) => m.id !== p.user.id) }
              : s.members,
          }
        })
        break
      }
      case 'channel.member_updated': {
        const p = env.payload as ChannelMemberUpdatedPayload
        set((s) => ({
          members: s.members[p.channel_id]
            ? {
                ...s.members,
                [p.channel_id]: s.members[p.channel_id].map((member) =>
                  member.id === p.user_id ? { ...member, role: p.role } : member,
                ),
              }
            : s.members,
          channels:
            me?.id === p.user_id
              ? s.channels.map((channel) =>
                  channel.id === p.channel_id ? { ...channel, my_role: p.role } : channel,
                )
              : s.channels,
        }))
        break
      }
      case 'doc.created': {
        const { doc } = env.payload as DocCreatedPayload
        set((s) => placeDoc(s, doc))
        break
      }
      case 'doc.updated': {
        const { doc } = env.payload as DocUpdatedPayload
        set((s) => placeDoc(s, doc))
        break
      }
      case 'doc.deleted': {
        const p = env.payload as DocDeletedPayload
        set((s) => applyDocDeleted(s, p))
        break
      }
      case 'doc.mention': {
        const { mention } = env.payload as DocMentionPayload
        if (get().mentions.some((m) => m.id === mention.id)) break
        set((s) => {
          const mentions = [mention, ...s.mentions]
          return { mentions, unreadMentionCount: countUnread(mentions) }
        })
        // Toast unless the user is already looking at the mentioned doc.
        const prefix =
          mention.doc.kind === 'canvas' ? 'x' : mention.doc.kind === 'board' ? 'b' : 'd'
        const deepLink = `/${prefix}/${mention.doc.id}`
        const viewing =
          typeof window !== 'undefined' &&
          window.location.pathname === deepLink
        const visibleHere =
          typeof document === 'undefined' || document.visibilityState === 'visible'
        if (
          !viewing &&
          !dndActive(get()) &&
          visibleHere &&
          !streamShieldsChannel(get(), mention.doc.channel_id)
        ) {
          const docTitle = mention.doc.title || 'Untitled'
          const who = mention.from_user.display_name
          const isCanvas = mention.doc.kind === 'canvas'
          const title = `${who} in ${isCanvas ? 'canvas' : 'doc'} ${docTitle}`
          toastNotify('mentioned you', {
            title,
            initial: who.trim().charAt(0).toUpperCase() || '?',
            onClick: () => navigateTo(deepLink),
          })
          playNotifySound()
          void showOsNotification(`${who} mentioned you`, docTitle, {
            deepLink,
            tag: `sharp-doc-${mention.doc.id}`,
          })
        }
        break
      }
      case 'prefs.updated': {
        // Another device (or another tab) changed appearance. The payload is
        // the fully merged blob, so applying it is idempotent — the originating
        // tab re-applying its own change is a no-op.
        const { ui } = env.payload as { ui: unknown }
        const merged = normalizeUiPrefs(ui, get().ui)
        applyUi(set, merged)
        writeLocalUiPrefs(merged)
        break
      }
      case 'notification.created': {
        const { notification } = env.payload as NotificationCreatedPayload
        // If its channel is already open in a focused window, treat it as seen:
        // land it in the inbox pre-read so it never lingers as unread.
        const focusedHere =
          typeof document !== 'undefined' &&
          document.hasFocus() &&
          get().currentChannelId === notification.channel_id
        const incoming =
          focusedHere && !notification.read_at
            ? { ...notification, read_at: new Date().toISOString() }
            : notification
        set((s) => {
          const exists = s.notifications.some((n) => n.id === incoming.id)
          return {
            notifications: [
              incoming,
              ...s.notifications.filter((n) => n.id !== incoming.id),
            ],
            notifUnread:
              !exists && !incoming.read_at ? s.notifUnread + 1 : s.notifUnread,
          }
        })
        if (focusedHere && !notification.read_at) {
          api.markNotificationsRead({ ids: [notification.id] }).catch(() => {})
        }
        // Alert (toast + OS notification) unless DND, or the message's channel is
        // already open in a focused window.
        const st = get()
        const visibleHere =
          typeof document === 'undefined' || document.visibilityState === 'visible'
        // A brand-new DM channel may not be in the list yet, so the dm kind
        // check can't rely on the channel lookup alone.
        const shielded =
          (notification.kind === 'dm' && streamChannelShielded(st, notification.channel_id)) ||
          streamShieldsChannel(st, notification.channel_id)
        if (!dndActive(st) && !focusedHere && visibleHere && !shielded) {
          const title =
            notification.kind === 'dm'
              ? notification.actor.display_name
              : notification.kind === 'task_assigned'
                ? `${notification.actor.display_name} assigned you ${notification.task_identifier ?? 'a task'}`
                : notification.kind === 'task_comment'
                  ? `${notification.actor.display_name} commented on ${notification.task_identifier ?? 'a task'}`
                  : `${notification.actor.display_name} in #${notification.channel_name}`
          const path = notificationPath(notification)
          const preview = gifPreviewText(notification.preview)
          toastNotify(preview || 'sent you a message', {
            title,
            initial: notification.actor.display_name.trim().charAt(0).toUpperCase() || '?',
            onClick: () => navigateTo(path),
          })
          playNotifySound()
          void showOsNotification(title, preview, {
            deepLink: path,
            tag: notification.task_id
              ? `sharp-task-${notification.task_id}`
              : `sharp-${notification.channel_id}`,
          })
        }
        break
      }
      case 'project.created':
      case 'project.updated': {
        const { project } = env.payload as ProjectCreatedPayload | ProjectUpdatedPayload
        set((s) => ({
          projects: s.projects.some((p) => p.id === project.id)
            ? s.projects.map((p) => (p.id === project.id ? project : p))
            : [...s.projects, project],
        }))
        break
      }
      case 'task.created':
      case 'task.updated': {
        const { task } = env.payload as TaskCreatedPayload | TaskUpdatedPayload
        // Celebrate a task crossing into a completed-type state. Keyed on the
        // state *type*, never its name — projects rename their states freely.
        const before = get().tasksByProject[task.project_id]?.find(
          (t) => t.id === task.id,
        )
        const typeOfState = (stateId: string | null | undefined) =>
          get()
            .projects.find((p) => p.id === task.project_id)
            ?.states.find((st) => st.id === stateId)?.type
        if (
          env.type === 'task.updated' &&
          before &&
          before.state_id !== task.state_id &&
          typeOfState(task.state_id) === 'completed'
        ) {
          confettiAt()
        }
        set((s) => {
          const list = s.tasksByProject[task.project_id]
          const tasksByProject = list
            ? {
                ...s.tasksByProject,
                [task.project_id]: sortTasks([
                  ...list.filter((t) => t.id !== task.id),
                  task,
                ]),
              }
            : s.tasksByProject
          const stateOf = s.projects
            .find((p) => p.id === task.project_id)
            ?.states.find((st) => st.id === task.state_id)
          const open =
            !stateOf || (stateOf.type !== 'completed' && stateOf.type !== 'canceled')
          let myTasks = s.myTasks.filter((t) => t.id !== task.id)
          if (s.me && task.assignee_id === s.me.id && open) myTasks = [task, ...myTasks]
          const detail = s.taskDetails[task.id]
          const taskDetails = detail
            ? { ...s.taskDetails, [task.id]: { ...detail, ...task } }
            : s.taskDetails
          return { tasksByProject, myTasks, taskDetails }
        })
        break
      }
      case 'task.deleted': {
        const { task_id, project_id } = env.payload as TaskDeletedPayload
        set((s) => {
          const list = s.tasksByProject[project_id]
          const taskDetails = { ...s.taskDetails }
          delete taskDetails[task_id]
          return {
            tasksByProject: list
              ? {
                  ...s.tasksByProject,
                  [project_id]: list.filter((t) => t.id !== task_id),
                }
              : s.tasksByProject,
            myTasks: s.myTasks.filter((t) => t.id !== task_id),
            taskDetails,
          }
        })
        break
      }
      case 'task.comment.created':
      case 'task.comment.updated':
      case 'task.comment.deleted': {
        const { comment } = env.payload as TaskCommentPayload
        set((s) => {
          const detail = s.taskDetails[comment.task_id]
          if (!detail) return {}
          const comments =
            env.type === 'task.comment.created'
              ? [...detail.comments.filter((c) => c.id !== comment.id), comment]
              : detail.comments.map((c) => (c.id === comment.id ? comment : c))
          return {
            taskDetails: {
              ...s.taskDetails,
              [comment.task_id]: { ...detail, comments },
            },
          }
        })
        break
      }
      case 'task.labels.changed': {
        void get().loadTaskLabels()
        break
      }
      case 'poll.created':
      case 'poll.updated': {
        const { poll } = env.payload as PollCreatedPayload | PollUpdatedPayload
        // A poll closing is the moment worth marking, not every incoming vote.
        const wasOpen = get().pollsById[poll.id]?.closed_at == null
        if (env.type === 'poll.updated' && wasOpen && poll.closed_at) confettiAt()
        set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
        break
      }
      case 'poll.deleted': {
        const { poll_id } = env.payload as PollDeletedPayload
        set((s) => {
          const pollsById = { ...s.pollsById }
          delete pollsById[poll_id]
          return { pollsById }
        })
        break
      }
      case 'voice.poll_state': {
        const { room_id, poll } = env.payload as VoicePollStatePayload
        if (get().voice.channelId === room_id) set({ callPoll: poll })
        break
      }
      case 'calendar.meeting_created':
      case 'calendar.meeting_updated': {
        const { meeting } = env.payload as
          | CalendarMeetingCreatedPayload
          | CalendarMeetingUpdatedPayload
        set((s) => ({
          calendarItems: upsertMeetingItem(s.calendarItems, s.calendarRange, meeting),
        }))
        break
      }
      case 'calendar.meeting_cancelled': {
        const { meeting_id } = env.payload as CalendarMeetingCancelledPayload
        set((s) => ({
          calendarItems: s.calendarItems.filter(
            (i) => !(i.source === 'native' && i.meeting.id === meeting_id),
          ),
        }))
        break
      }
      case 'calendar.synced': {
        const p = env.payload as CalendarSyncedPayload
        set((s) => ({
          calendarConnections: s.calendarConnections.map((c) =>
            c.id === p.account_id
              ? { ...c, last_synced_at: p.last_synced_at }
              : c,
          ),
        }))
        // Refetch the visible window so newly-synced Google events appear.
        const range = get().calendarRange
        if (range) void get().loadCalendar(range.from, range.to)
        break
      }
      case 'calendar.reminder': {
        const p = env.payload as CalendarReminderPayload
        if (
          dndActive(get()) ||
          (typeof document !== 'undefined' && document.visibilityState !== 'visible')
        ) break
        const when = p.kind === 'lead' ? 'starts soon' : 'starting now'
        const title = p.title || 'Meeting'
        const deepLink = p.join_path ?? '/calendar'
        toastNotify(when, {
          title,
          initial: '📅',
          onClick: () => navigateTo(deepLink),
        })
        playNotifySound()
        void showOsNotification(title, when, {
          deepLink,
          tag: `sharp-cal-${p.ref_id}`,
        })
        break
      }
      default:
        break
    }
}
