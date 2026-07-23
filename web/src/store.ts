import { create } from 'zustand'
import { api, ApiRequestError, clearToken, setSessionToken, setToken } from './lib/api'
import type { VoiceClient } from './lib/voice'
import { annotations } from './lib/annotations'
import {
  loadVideoBackground,
  saveVideoBackground,
  type VideoBackground,
} from './lib/videoBackgrounds'
import {
  loadVoiceDevicePrefs,
  saveVoiceAudioDevice,
  saveVoiceVideoDevice,
} from './lib/voicePrefs'
import { isTranscriptionSupported, PhraseRecognizer } from './lib/speech'
import { WsClient } from './lib/ws'
import { cmpId } from './lib/util'
import { gifPreviewText } from './lib/gif'
import {
  decryptDmMessage,
  encryptDmMessage,
  ensureDevice,
  getDevices,
  getLocalDevice,
  invalidateDevices,
  isChannelEncrypted,
} from './lib/e2ee'
import { resolveEncryptedAttachments } from './lib/e2ee/attachments'
import { idbClear } from './lib/e2ee/idb'
import { indexDecryptedMessage, removeIndexedMessage } from './lib/e2ee/search'
import { markAllDeviceSetsChanged, markDeviceSetChanged } from './lib/e2ee/trust'
import { restoreBackup } from './lib/e2ee/backup'
import { toastError, toastInfo, toastNotify } from './lib/toast'
import { navigateTo } from './lib/nav'
import { notificationPath } from './lib/types'
import {
  disablePush,
  enableNotifications,
  getNotificationState,
  initPush,
  initialNotificationState,
  navigateToChannel,
  showOsNotification,
  type NotificationSetupState,
} from './lib/notify'
import {
  playHuddleRingSound,
  playNotifySound,
  playVoiceJoinSound,
  playVoiceLeaveSound,
  sound,
} from './lib/sound'
import type {
  Channel,
  ChannelMember,
  ChannelNotifyMode,
  PrefsUpdate,
  ChannelCreatedPayload,
  ChannelUpdatedPayload,
  ChannelDeletedPayload,
  ChannelMemberPayload,
  ChannelMemberUpdatedPayload,
  ChannelRole,
  ChatLayout,
  Doc,
  DocCreatedPayload,
  DocDeletedPayload,
  DocMention,
  DocMentionPayload,
  DocUpdatedPayload,
  GifConfig,
  HelloPayload,
  Message,
  MessageCreatedPayload,
  MessageDeletedPayload,
  MessageUpdatedPayload,
  DuckStreakPayload,
  E2eeDevicesChangedPayload,
  EncryptedAttachment,
  Notification,
  NotificationCreatedPayload,
  PresencePayload,
  ReactionPayload,
  TypingPayload,
  User,
  UserUpdatedPayload,
  VoiceErrorPayload,
  VoiceAnnotatePayload,
  VoiceAnnotateClearPayload,
  VoiceAnnotateStatePayload,
  VoiceParticipantJoinedPayload,
  VoiceParticipantLeftPayload,
  VoiceParticipantUpdatedPayload,
  VoiceRoomSnapshot,
  VoiceStatePayload,
  VoiceTrigger,
  VoiceTriggerCreatedPayload,
  VoiceTriggerDeletedPayload,
  VoiceTriggerFiredPayload,
  MeetingStartedPayload,
  MeetingEndedPayload,
  CalendarConnection,
  CalendarItem,
  ScheduledMeeting,
  CalendarMeetingCreatedPayload,
  CalendarMeetingUpdatedPayload,
  CalendarMeetingCancelledPayload,
  CalendarSyncedPayload,
  CalendarReminderPayload,
  Poll,
  CallPoll,
  PollCreatedPayload,
  PollUpdatedPayload,
  PollDeletedPayload,
  VoicePollStatePayload,
  Project,
  ProjectCreatedPayload,
  ProjectUpdatedPayload,
  Task,
  TaskCommentPayload,
  TaskCreatedPayload,
  TaskDeletedPayload,
  TaskDetail,
  TaskLabel,
  TaskUpdateInput,
  TaskUpdatedPayload,
  SharpyConversation,
  SharpyMessage,
  SharpySource,
  WsEnvelope,
} from './lib/types'

const PAGE = 50

let voiceRecognizer: PhraseRecognizer | null = null

function stopVoiceRecognizer() {
  voiceRecognizer?.stop()
  voiceRecognizer = null
}

type TypingEntry = { display_name: string; expiresAt: number }

type ThreadState = {
  open: boolean
  parentId: string | null
  parent: Message | null
  replies: Message[]
  loading: boolean
}

export type VoiceRoom = Record<
  string,
  {
    user_id: string
    display_name: string
    annotation_color: string
    guest: boolean
    muted: boolean
    transcribing: boolean
    camera_on: boolean
    screen_on: boolean
    screen_stream_id: string | null
    hand_raised: boolean
    hand_raised_at: number | null
    joined_at: string
  }
>

export type VoiceStageMode = 'expanded' | 'compact' | 'mini' | 'full'
export type RailPosition = 'left' | 'bottom' | 'top'

type VoiceState = {
  channelId: string | null
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting'
  muted: boolean
  noiseSuppression: boolean
  noiseSuppressionAvailable: boolean
  videoBackground: VideoBackground
  handRaised: boolean
  transcribing: boolean
  transcriptionAvailable: boolean
  roastArmed: boolean
  speaking: Record<string, boolean>
  cameraStatus: 'off' | 'starting' | 'on'
  screenStatus: 'off' | 'starting' | 'on'
  stageMode: VoiceStageMode
  audioDeviceId: string | null
  videoDeviceId: string | null
  localStream: MediaStream | null
  remoteStreams: Record<string, MediaStream>
  localScreenStream: MediaStream | null
  remoteScreenStreams: Record<string, MediaStream>
  client: VoiceClient | null
  // Screen-share annotations: whether non-sharers may draw (server-authoritative),
  // and whether the local pen tool is engaged.
  annotationsAllowed: boolean
  annotating: boolean
}

export type ChannelMessages = {
  list: Message[] // top-level, ascending
  loaded: boolean
  loading: boolean
  hasMore: boolean
}

/**
 * Whether alerts should be suppressed right now: the manual DND toggle, or an
 * active scheduled quiet-hours window (evaluated against the local clock, so it
 * matches what the user configured regardless of the stored tz offset).
 */
export function dndActive(s: {
  dnd: boolean
  dndScheduled: boolean
  dndStart: number | null
  dndEnd: number | null
}): boolean {
  if (s.dnd) return true
  if (!s.dndScheduled || s.dndStart == null || s.dndEnd == null) return false
  const now = new Date()
  const cur = now.getHours() * 60 + now.getMinutes()
  const { dndStart: a, dndEnd: b } = s
  if (a === b) return false
  return a < b ? cur >= a && cur < b : cur >= a || cur < b
}

/** Streaming mode is on: manual toggle, or actively sharing the screen in a call. */
export function streamingActive(s: {
  streamManual: boolean
  voice: { screenStatus: 'off' | 'starting' | 'on' }
}): boolean {
  return s.streamManual || s.voice.screenStatus === 'on'
}

type StreamShieldState = {
  streamManual: boolean
  streamRevealAllUntil: number | null
  streamRevealChannels: Record<string, number>
  voice: { screenStatus: 'off' | 'starting' | 'on' }
}

/** The privacy shield is enforcing right now (streaming and not inside an "everything" reveal window). */
export function streamShieldOn(s: StreamShieldState): boolean {
  if (!streamingActive(s)) return false
  return !(s.streamRevealAllUntil && Date.now() < s.streamRevealAllUntil)
}

/**
 * Whether this channel's content must stay hidden right now. A per-channel
 * reveal window lifts the shield for that conversation only; no channel id
 * (e.g. local encrypted-DM search hits) stays hidden while the shield is on.
 */
export function streamChannelShielded(
  s: StreamShieldState,
  channelId: string | null | undefined,
): boolean {
  if (!streamShieldOn(s)) return false
  if (!channelId) return true
  const until = s.streamRevealChannels[channelId]
  return !(until && Date.now() < until)
}

/**
 * Alerts from this channel must stay off-screen while shielded (private/DM only,
 * honoring per-channel reveal windows). Server web-push fires outside the app
 * and can't be gated here — this covers in-app toasts, sounds, and
 * client-routed OS notifications only.
 */
function streamShieldsChannel(
  st: StreamShieldState & { channels: Channel[] },
  channelId: string | null | undefined,
): boolean {
  if (!channelId) return false
  const kind = st.channels.find((c) => c.id === channelId)?.kind
  if (kind !== 'private' && kind !== 'dm') return false
  return streamChannelShielded(st, channelId)
}

type State = {
  // auth
  token: string | null
  me: User | null
  ready: boolean

  // guest call sessions (public /call/:token page). isGuest gates the voice-only
  // UI; guestChannelId is the bound channel; guestRevoked flips when the link is
  // regenerated mid-call; guestPendingJoin one-shots the auto-join on first hello.
  isGuest: boolean
  guestChannelId: string | null
  guestRevoked: boolean
  guestPendingJoin: boolean

  // directory
  users: Record<string, User>
  // Personal nicknames the signed-in user has set for others (targetId → nickname).
  nicknames: Record<string, string>
  online: Set<string>
  myConnId: string | null

  // channels
  channels: Channel[]
  currentChannelId: string | null

  // messages keyed by channel id
  byChannel: Record<string, ChannelMessages>

  pollsById: Record<string, Poll>
  callPoll: CallPoll | null

  // undefined while device availability is unresolved; false means plaintext fallback.
  dmEncryption: Record<string, boolean | undefined>
  dmPartnerReady: Record<string, boolean | undefined>
  backupRestorePrompt: boolean

  // GIF feature flags + per-channel fast-streak activity used by duck suggestions
  gifConfig: GifConfig | null
  duckActivity: Record<string, { count: number; lastAt: number }>

  // members cache keyed by channel id
  members: Record<string, ChannelMember[]>
  // shared voice triggers; missing key means not loaded yet
  channelVoiceTriggers: Record<string, VoiceTrigger[]>

  // thread panel
  thread: ThreadState

  // typing: channelId -> userId -> entry
  typing: Record<string, Record<string, TypingEntry>>

  // quick switcher
  quickSwitcherOpen: boolean
  // ⌘/Ctrl+F text search palette
  searchOpen: boolean
  // chat inbox (notifications) panel
  inboxOpen: boolean

  // --- Sharpy: AI workspace assistant (slide-over) ---
  sharpyOpen: boolean
  sharpyEnabled: boolean
  sharpyStatusChecked: boolean
  sharpyConversations: SharpyConversation[]
  sharpyActiveId: string | null
  sharpyMessages: SharpyMessage[]
  sharpyLoading: boolean
  sharpyStreaming: boolean
  sharpyStreamText: string
  sharpyStreamSources: SharpySource[] | null

  // per-composer draft text, keyed `c:<channelId>` (main) or `t:<parentId>` (thread)
  drafts: Record<string, string>
  // per-channel quote-reply target (channelId -> message); each chat keeps its own
  replyTargets: Record<string, Message>
  // bumped to ask a specific composer (by draft key) to focus
  focusRequest: { key: string; n: number } | null
  // message currently under the pointer (keyboard-shortcut target); not subscribed
  // to by rows, so hovering doesn't re-render them
  activeMessageId: string | null
  // which message's reaction palette is open (mouse or keyboard), or null
  paletteForMessageId: string | null
  // a message to scroll to + highlight after landing from search; cleared on the
  // next user interaction. `query` is the searched text (word-highlighted in the row).
  focus: { channelId: string; messageId: string; query: string } | null

  // --- docs (Phase 2) ---
  docsByChannel: Record<string, Doc[]> // active (non-trashed) docs, updated_at desc
  docsLoaded: Set<string> // channel ids whose active docs were fully fetched
  trashByChannel: Record<string, Doc[]> // trashed docs, loaded on demand
  docMeta: Record<string, Doc> // individual doc meta cache by id
  mentions: DocMention[]
  unreadMentionCount: number

  // notifications
  notifications: Notification[]
  notifUnread: number
  dnd: boolean
  mutedChannels: Set<string>
  channelModes: Record<string, ChannelNotifyMode>
  notifyDm: boolean
  notifyMention: boolean
  notifyReply: boolean
  notifyTask: boolean
  notifyPoll: boolean
  dndScheduled: boolean
  dndStart: number | null
  dndEnd: number | null
  tzOffset: number
  notifyEnabled: boolean
  notificationState: NotificationSetupState
  notifHasMore: boolean

  // chat layout preference: null until the user has chosen (triggers first-run chooser)
  chatLayout: ChatLayout | null

  // Device-local desktop navigation preference.
  railPosition: RailPosition
  // Bottom dock only: slide away until the cursor nears the bottom edge.
  dockAutoHide: boolean

  // --- streaming mode (privacy shield) ---
  // Manual arm for external capture (OBS etc.); in-app screen share arms it automatically.
  streamManual: boolean
  // "Reveal everything" window expiry (epoch ms); ephemeral, never persisted.
  streamRevealAllUntil: number | null
  // Per-conversation reveal windows (channelId → epoch ms expiry); ephemeral.
  streamRevealChannels: Record<string, number>
  // While streaming (shield on or paused), ignore personal nicknames and show plain display names.
  streamRevertNicknames: boolean

  // ephemeral voice rooms + this connection's active call
  voiceRooms: Record<string, VoiceRoom>
  activeMeetings: Record<string, string>
  voice: VoiceState

  // --- calendar (Phase 5) ---
  calendarConnections: CalendarConnection[]
  calendarItems: CalendarItem[]
  // the [from, to) ISO window currently loaded into calendarItems, or null
  calendarRange: { from: string; to: string } | null
  // local-day key (YYYY-MM-DD) the agenda is focused on
  calendarSelectedDate: string | null

  // --- tasks (Phase 7) ---
  projects: Project[]
  taskLabels: TaskLabel[]
  // per-project task lists, sorted by sort_order (board/list views read these)
  tasksByProject: Record<string, Task[]>
  myTasks: Task[]
  // detail cache for open peeks; WS events patch entries that are present
  taskDetails: Record<string, TaskDetail>
  activeProjectId: string | null

  // ws
  ws: WsClient | null

  // --- actions ---
  init: (token: string, me: User) => Promise<void>
  initGuestCall: (
    guestToken: string,
    user: { id: string; name: string },
    channelId: string,
  ) => void
  leaveGuestCall: () => void
  rejoinGuestCall: () => void
  logout: () => void
  refetchDirectory: () => Promise<void>
  setNickname: (userId: string, nickname: string) => Promise<void>
  clearNickname: (userId: string) => Promise<void>
  refreshGifConfig: () => Promise<void>
  resetDuckActivity: (channelId: string) => void
  refreshDmEncryption: (userId?: string) => Promise<void>
  isDmEncrypted: (channelId: string) => boolean
  restoreEncryptionBackup: (passphrase: string) => Promise<void>
  startFreshEncryption: () => Promise<void>

  setCurrentChannel: (id: string | null) => void
  loadMessages: (channelId: string) => Promise<void>
  loadOlder: (channelId: string) => Promise<void>
  sendMessage: (
    channelId: string,
    content: string,
    parentId?: string,
    attachmentIds?: string[],
    replyToId?: string,
    encryptedAttachments?: EncryptedAttachment[],
  ) => Promise<void>
  markRead: (channelId: string, messageId: string) => void

  createChannel: (input: {
    name: string
    kind: 'public' | 'private'
    topic?: string
    member_ids?: string[]
  }) => Promise<Channel>
  joinChannel: (id: string) => Promise<void>
  leaveChannel: (id: string) => Promise<void>
  updateChannel: (
    id: string,
    input: { name?: string; topic?: string; kind?: 'public' | 'private' },
  ) => Promise<Channel>
  deleteChannel: (id: string) => Promise<void>
  addChannelMembers: (id: string, userIds: string[]) => Promise<void>
  removeChannelMember: (id: string, userId: string) => Promise<void>
  setMemberRole: (channelId: string, userId: string, role: ChannelRole) => Promise<void>
  openDm: (userId: string) => Promise<Channel>
  loadMembers: (id: string) => Promise<void>
  loadChannelVoiceTriggers: (channelId: string) => Promise<void>
  createChannelVoiceTrigger: (channelId: string, phrase: string) => Promise<VoiceTrigger>
  deleteChannelVoiceTrigger: (channelId: string, triggerId: string) => Promise<void>

  toggleReaction: (msg: Message, emoji: string) => Promise<void>
  applyReaction: (
    messageId: string,
    channelId: string,
    emoji: string,
    userId: string,
    add: boolean,
  ) => void
  editMessage: (messageId: string, content: string) => Promise<void>
  deleteMessage: (messageId: string) => Promise<void>

  createPoll: (
    channelId: string,
    input: {
      question: string
      options: string[]
      multi: boolean
      pinned: boolean
      expires_at?: string
    },
  ) => Promise<Poll>
  votePoll: (pollId: string, optionIds: string[]) => Promise<void>
  retractVote: (pollId: string) => Promise<void>
  closePoll: (pollId: string) => Promise<void>
  pinPoll: (pollId: string, pinned: boolean) => Promise<void>
  deletePoll: (pollId: string) => Promise<void>
  fetchPoll: (pollId: string) => Promise<Poll>
  fetchActivePolls: (channelId: string) => Promise<void>
  createCallPoll: (input: {
    question: string
    options: string[]
    multi: boolean
    expires_at?: string
    preset?: string
  }) => void
  voteCallPoll: (pollId: string, optionIds: string[]) => void
  closeCallPoll: (pollId: string) => void

  openThread: (parentId: string) => Promise<void>
  closeThread: () => void

  setQuickSwitcher: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setInboxOpen: (open: boolean) => void

  // sharpy actions
  initSharpy: () => Promise<void>
  setSharpyOpen: (open: boolean) => void
  openSharpyConversation: (id: string) => Promise<void>
  newSharpyConversation: () => void
  deleteSharpyConversation: (id: string) => Promise<void>
  sendSharpy: (content: string) => Promise<void>
  setDraft: (key: string, text: string) => void
  setReplyTarget: (channelId: string, msg: Message | null) => void
  requestComposerFocus: (key: string) => void
  setActiveMessage: (id: string | null) => void
  setPaletteFor: (id: string | null) => void
  setFocus: (focus: { channelId: string; messageId: string; query: string } | null) => void
  sendTyping: (channelId: string) => void
  pruneTyping: () => void

  // voice actions
  joinVoice: (
    channelId: string,
    opts?: { stageMode?: VoiceStageMode; linkToken?: string },
  ) => Promise<void>
  connectVoiceMedia: (payload: VoiceStatePayload) => Promise<void>
  leaveVoice: () => void
  toggleVoiceMute: () => void
  toggleNoiseSuppression: () => Promise<void>
  setVoiceVideoBackground: (background: VideoBackground) => Promise<void>
  toggleVoiceHand: () => void
  toggleTranscription: () => void
  toggleVoiceCamera: () => void
  toggleVoiceScreen: () => Promise<void>
  setVoiceAudioDevice: (deviceId: string) => Promise<void>
  setVoiceVideoDevice: (deviceId: string) => Promise<void>
  setVoiceStageMode: (mode: VoiceStageMode) => void
  toggleAnnotating: () => void
  setAnnotationsAllowed: (allowed: boolean) => void
  clearAnnotations: () => void

  // docs actions
  loadChannelDocs: (channelId: string) => Promise<void>
  loadChannelTrash: (channelId: string) => Promise<void>
  createDoc: (
    channelId: string,
    input?: { title?: string; icon?: string; kind?: 'doc' | 'canvas' | 'board' },
  ) => Promise<Doc>
  createCanvas: (channelId: string, input?: { title?: string; icon?: string }) => Promise<Doc>
  createBoard: (channelId: string, input?: { title?: string; icon?: string }) => Promise<Doc>
  fetchDoc: (id: string) => Promise<Doc>
  patchDoc: (
    id: string,
    input: {
      title?: string
      icon?: string
      everyone_role?: 'editor' | 'viewer' | 'none' | 'inherit'
    },
  ) => Promise<Doc>
  trashDoc: (id: string) => Promise<void>
  restoreDoc: (id: string) => Promise<Doc>
  permanentDeleteDoc: (id: string) => Promise<void>
  loadMentions: () => Promise<void>
  markMentionsRead: (ids: string[]) => Promise<void>

  // calendar actions
  loadCalendar: (from: string, to: string) => Promise<void>
  loadCalendarConnections: () => Promise<void>
  createScheduledMeeting: (input: {
    title: string
    description?: string
    start_at: string
    end_at: string
    all_day?: boolean
    channel_id?: string | null
    standalone_call_id?: string | null
    attendee_ids?: string[]
    post_card?: boolean
  }) => Promise<ScheduledMeeting>
  updateScheduledMeeting: (
    id: string,
    input: {
      title?: string
      description?: string
      start_at?: string
      end_at?: string
      all_day?: boolean
      attendee_ids?: string[]
    },
  ) => Promise<ScheduledMeeting>
  cancelScheduledMeeting: (id: string) => Promise<void>
  rsvpMeeting: (id: string, response: string) => Promise<void>
  setCalendarSelectedDate: (dayKey: string | null) => void
  joinScheduledMeeting: (joinPath: string | null) => void

  // tasks actions
  loadProjects: () => Promise<void>
  loadTaskLabels: () => Promise<void>
  loadProjectTasks: (projectId: string) => Promise<void>
  loadMyTasks: () => Promise<void>
  loadTaskDetail: (taskId: string) => Promise<TaskDetail>
  setActiveProject: (projectId: string | null) => void
  // optimistic field update: applies locally, PATCHes, refetches on failure
  patchTask: (taskId: string, patch: TaskUpdateInput) => Promise<void>

  // notifications + preferences
  loadInboxAndPrefs: () => Promise<void>
  loadMoreNotifications: () => Promise<void>
  markNotifRead: (id: string) => void
  markAllNotifRead: () => void
  markChannelNotifsRead: (channelId: string) => void
  setDnd: (dnd: boolean) => Promise<void>
  updateNotifyPrefs: (patch: PrefsUpdate) => Promise<void>
  toggleMute: (channelId: string) => Promise<void>
  setChannelMode: (channelId: string, mode: ChannelNotifyMode) => Promise<void>
  enableDesktopNotifications: () => Promise<void>
  disableDesktopNotifications: () => Promise<void>

  // profile + chat layout
  setChatLayout: (layout: ChatLayout) => Promise<void>
  setRailPosition: (position: RailPosition) => void
  setDockAutoHide: (autoHide: boolean) => void
  setStreamManual: (on: boolean) => void
  setStreamRevertNicknames: (on: boolean) => void
  revealStreamAll: () => void
  revealStreamChannel: (channelId: string) => void
  clearStreamReveals: () => void
  expireStreamReveals: () => void
  updateProfile: (input: { display_name?: string }) => Promise<void>
  uploadAvatar: (file: Blob, onProgress?: (f: number) => void) => Promise<void>
  removeAvatar: () => Promise<void>

  applyWsEvent: (env: WsEnvelope) => void
  totalUnread: () => number
}

// sort_order is a fractional-index string; id tie-break keeps order stable.
function sortTasks(list: Task[]): Task[] {
  return [...list].sort((a, b) =>
    a.sort_order < b.sort_order
      ? -1
      : a.sort_order > b.sort_order
        ? 1
        : a.id < b.id
          ? -1
          : 1,
  )
}

function emptyChannelMessages(): ChannelMessages {
  return { list: [], loaded: false, loading: false, hasMore: true }
}

const NOISE_SUPPRESSION_KEY = 'sharp.noiseSuppression'
const RAIL_POSITION_KEY = 'sharp.railPosition'
const DOCK_AUTOHIDE_KEY = 'sharp.dockAutoHide'
const STREAM_MANUAL_KEY = 'sharp.streamManual'
const STREAM_REVERT_NICKS_KEY = 'sharp.streamRevertNicknames'

function storedNoiseSuppression(): boolean {
  try {
    return window.localStorage.getItem(NOISE_SUPPRESSION_KEY) !== '0'
  } catch {
    return true
  }
}

function storedRailPosition(): RailPosition {
  try {
    const stored = window.localStorage.getItem(RAIL_POSITION_KEY)
    return stored === 'bottom' || stored === 'top' ? stored : 'left'
  } catch {
    return 'left'
  }
}

function storedDockAutoHide(): boolean {
  try {
    return window.localStorage.getItem(DOCK_AUTOHIDE_KEY) === '1'
  } catch {
    return false
  }
}

function storedStreamManual(): boolean {
  try {
    return window.localStorage.getItem(STREAM_MANUAL_KEY) === '1'
  } catch {
    return false
  }
}

function storedStreamRevertNicknames(): boolean {
  try {
    return window.localStorage.getItem(STREAM_REVERT_NICKS_KEY) === '1'
  } catch {
    return false
  }
}

function emptyVoiceState(): VoiceState {
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

export const useStore = create<State>((set, get) => ({
  token: null,
  me: null,
  ready: false,
  isGuest: false,
  guestChannelId: null,
  guestRevoked: false,
  guestPendingJoin: false,
  users: {},
  nicknames: {},
  online: new Set(),
  myConnId: null,
  channels: [],
  currentChannelId: null,
  byChannel: {},
  pollsById: {},
  callPoll: null,
  dmEncryption: {},
  dmPartnerReady: {},
  backupRestorePrompt: false,
  gifConfig: null,
  duckActivity: {},
  members: {},
  channelVoiceTriggers: {},
  thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
  typing: {},
  quickSwitcherOpen: false,
  searchOpen: false,
  inboxOpen: false,
  sharpyOpen: false,
  sharpyEnabled: false,
  sharpyStatusChecked: false,
  sharpyConversations: [],
  sharpyActiveId: null,
  sharpyMessages: [],
  sharpyLoading: false,
  sharpyStreaming: false,
  sharpyStreamText: '',
  sharpyStreamSources: null,
  drafts: {},
  replyTargets: {},
  focusRequest: null,
  activeMessageId: null,
  paletteForMessageId: null,
  focus: null,
  docsByChannel: {},
  docsLoaded: new Set(),
  trashByChannel: {},
  docMeta: {},
  mentions: [],
  unreadMentionCount: 0,
  notifications: [],
  notifUnread: 0,
  dnd: false,
  mutedChannels: new Set(),
  channelModes: {},
  notifyDm: true,
  notifyMention: true,
  notifyReply: true,
  notifyTask: true,
  notifyPoll: true,
  dndScheduled: false,
  dndStart: null,
  dndEnd: null,
  tzOffset: 0,
  notifyEnabled: false,
  notificationState: initialNotificationState(),
  notifHasMore: false,
  chatLayout: null,
  railPosition: storedRailPosition(),
  dockAutoHide: storedDockAutoHide(),
  streamManual: storedStreamManual(),
  streamRevealAllUntil: null,
  streamRevealChannels: {},
  streamRevertNicknames: storedStreamRevertNicknames(),
  voiceRooms: {},
  activeMeetings: {},
  voice: emptyVoiceState(),
  projects: [],
  taskLabels: [],
  tasksByProject: {},
  myTasks: [],
  taskDetails: {},
  activeProjectId: null,
  calendarConnections: [],
  calendarItems: [],
  calendarRange: null,
  calendarSelectedDate: null,
  ws: null,

  async init(token, me) {
    setToken(token)
    set({ token, me, ready: false })
    void (async () => {
      try {
        const local = await getLocalDevice()
        if (!local) {
          try {
            await api.getBackup()
            set({ backupRestorePrompt: true })
            return
          } catch (error) {
            if (!(error instanceof ApiRequestError) || error.status !== 404) throw error
          }
        }
        await ensureDevice()
        invalidateDevices(me.id)
        await get().refreshDmEncryption(me.id)
      } catch (error) {
        console.warn('Could not initialize E2EE device', error)
      }
    })()
    const existing = get().ws
    if (existing) existing.close()
    const ws = new WsClient({
      handler: (env) => get().applyWsEvent(env),
      onReconnect: () => {
        get().refetchDirectory()
        get().loadMentions()
        get().loadInboxAndPrefs()
        const cur = get().currentChannelId
        if (cur) {
          get().loadMessages(cur)
          if (get().channels.find((channel) => channel.id === cur)?.kind !== 'dm') {
            void get().fetchActivePolls(cur).catch(() => {})
          }
        }
        for (const channelId of Object.keys(get().channelVoiceTriggers)) {
          void get().loadChannelVoiceTriggers(channelId).catch(() => {})
        }
        void get().loadProjects()
        void get().loadMyTasks()
        const activeProject = get().activeProjectId
        if (activeProject) void get().loadProjectTasks(activeProject)
      },
    })
    set({ ws })
    ws.connect()

    void api
      .gifConfig()
      .then((gifConfig) => set({ gifConfig }))
      .catch(() => {})

    await get().refetchDirectory()
    get().loadMentions()
    void get().initSharpy()
    void get().loadProjects()
    void get().loadTaskLabels()
    void get().loadMyTasks()
    await get().loadInboxAndPrefs()
    set({ ready: true })

    // Refine permission/subscription state without prompting. Existing grants
    // are re-subscribed after deployments or browser subscription rotation.
    const notificationState = await getNotificationState()
    if (notificationState === 'subscribed' || notificationState === 'prompt') {
      const next = await initPush()
      set({ notificationState: next, notifyEnabled: next === 'subscribed' })
    } else {
      set({ notificationState, notifyEnabled: false })
    }
  },

  initGuestCall(guestToken, user, channelId) {
    // Guests authenticate through the in-memory session override so this never
    // touches a real login's `sharp.token`.
    setSessionToken(guestToken)
    const me: User = {
      id: user.id,
      // The User type marks email optional; guests simply have none.
      email: undefined,
      display_name: user.name,
      avatar_url: null,
      created_at: new Date().toISOString(),
    }
    const existing = get().ws
    if (existing) existing.close()
    // Voice-only bootstrap: no directory/mentions/inbox/prefs/push. joinVoice
    // fires from the `hello` handler once myConnId is set (see applyWsEvent).
    const ws = new WsClient({
      handler: (env) => get().applyWsEvent(env),
    })
    set({
      token: guestToken,
      me,
      ready: true,
      isGuest: true,
      guestChannelId: channelId,
      guestRevoked: false,
      guestPendingJoin: true,
      ws,
      myConnId: null,
      voice: emptyVoiceState(),
      callPoll: null,
    })
    ws.connect()
  },

  leaveGuestCall() {
    get().leaveVoice()
  },

  rejoinGuestCall() {
    const channelId = get().guestChannelId
    if (!channelId) return
    set({ guestRevoked: false })
    void get().joinVoice(channelId)
  },

  logout() {
    get().leaveVoice()
    const ws = get().ws
    if (ws) ws.close()
    const pushToken = get().token
    // Capture auth for server detachment, then clear the session immediately.
    // Cleanup is best-effort and never blocks logout UI.
    void disablePush(pushToken)
    void Promise.all([idbClear('messages'), idbClear('trust')]).catch(() => {
      // Logout remains immediate when browser storage is unavailable.
    })
    clearToken()
    setSessionToken(null)
    set({
      token: null,
      me: null,
      ready: false,
      isGuest: false,
      guestChannelId: null,
      guestRevoked: false,
      guestPendingJoin: false,
      users: {},
      nicknames: {},
      online: new Set(),
      myConnId: null,
      channels: [],
      currentChannelId: null,
      byChannel: {},
      pollsById: {},
      callPoll: null,
      dmEncryption: {},
      dmPartnerReady: {},
      backupRestorePrompt: false,
      gifConfig: null,
      duckActivity: {},
      members: {},
      channelVoiceTriggers: {},
      thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
      typing: {},
      quickSwitcherOpen: false,
      searchOpen: false,
      inboxOpen: false,
      sharpyOpen: false,
      sharpyEnabled: false,
      sharpyStatusChecked: false,
      sharpyConversations: [],
      sharpyActiveId: null,
      sharpyMessages: [],
      sharpyLoading: false,
      sharpyStreaming: false,
      sharpyStreamText: '',
      sharpyStreamSources: null,
      drafts: {},
      replyTargets: {},
      focusRequest: null,
      activeMessageId: null,
      paletteForMessageId: null,
      focus: null,
      docsByChannel: {},
      docsLoaded: new Set(),
      trashByChannel: {},
      docMeta: {},
      mentions: [],
      unreadMentionCount: 0,
      notifications: [],
      notifUnread: 0,
      dnd: false,
      mutedChannels: new Set(),
      channelModes: {},
      notifyDm: true,
      notifyMention: true,
      notifyReply: true,
      notifyTask: true,
      notifyPoll: true,
      dndScheduled: false,
      dndStart: null,
      dndEnd: null,
      tzOffset: 0,
      notifyEnabled: false,
      notificationState: initialNotificationState(),
      chatLayout: null,
      notifHasMore: false,
      voiceRooms: {},
      activeMeetings: {},
      voice: emptyVoiceState(),
      ws: null,
    })
  },

  async refetchDirectory() {
    try {
      const [usersRes, channelsRes] = await Promise.all([api.users(), api.channels()])
      const users: Record<string, User> = {}
      for (const u of usersRes.users) users[u.id] = u
      set({
        users,
        online: new Set(usersRes.online_user_ids),
        channels: channelsRes.channels,
      })
      void get().refreshDmEncryption()
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async refreshGifConfig() {
    try {
      const gifConfig = await api.gifConfig()
      set({ gifConfig })
    } catch {
      // Keep last known config when refresh fails.
    }
  },

  async loadChannelVoiceTriggers(channelId) {
    const { triggers } = await api.voiceTriggers.listChannel(channelId)
    set((s) => ({
      channelVoiceTriggers: { ...s.channelVoiceTriggers, [channelId]: triggers },
    }))
  },

  async createChannelVoiceTrigger(channelId, phrase) {
    const trigger = await api.voiceTriggers.createChannel(channelId, phrase)
    set((s) => {
      const current = s.channelVoiceTriggers[channelId]
      if (!current || current.some((item) => item.id === trigger.id)) return {}
      return {
        channelVoiceTriggers: {
          ...s.channelVoiceTriggers,
          [channelId]: [...current, trigger],
        },
      }
    })
    return trigger
  },

  async deleteChannelVoiceTrigger(channelId, triggerId) {
    await api.voiceTriggers.deleteChannel(channelId, triggerId)
    set((s) => {
      const current = s.channelVoiceTriggers[channelId]
      if (!current) return {}
      return {
        channelVoiceTriggers: {
          ...s.channelVoiceTriggers,
          [channelId]: current.filter((trigger) => trigger.id !== triggerId),
        },
      }
    })
  },

  resetDuckActivity(channelId) {
    set((s) => ({
      duckActivity: {
        ...s.duckActivity,
        [channelId]: {
          count: 0,
          lastAt: s.duckActivity[channelId]?.lastAt ?? 0,
        },
      },
    }))
  },

  async refreshDmEncryption(userId) {
    const state = get()
    if (!state.me) return
    const dms = state.channels.filter(
      (channel) =>
        channel.kind === 'dm' &&
        channel.dm_user &&
        (!userId || userId === state.me?.id || userId === channel.dm_user.id),
    )
    await Promise.all(
      dms.map(async (channel) => {
        const partnerId = channel.dm_user?.id
        if (!partnerId) return
        try {
          const [mine, partner] = await Promise.all([
            getDevices(state.me!.id),
            getDevices(partnerId),
          ])
          set((current) => ({
            dmEncryption: {
              ...current.dmEncryption,
              [channel.id]: mine.length > 0 && isChannelEncrypted(channel, partner),
            },
            dmPartnerReady: {
              ...current.dmPartnerReady,
              [channel.id]: partner.length > 0,
            },
          }))
        } catch (error) {
          console.warn('Could not resolve E2EE devices', error)
        }
      }),
    )
  },

  isDmEncrypted(channelId) {
    return get().dmEncryption[channelId] === true
  },

  async restoreEncryptionBackup(passphrase) {
    await restoreBackup(passphrase)
    const me = get().me
    if (me) invalidateDevices(me.id)
    set({ backupRestorePrompt: false })
    await get().refreshDmEncryption(me?.id)
  },

  async startFreshEncryption() {
    await ensureDevice()
    const me = get().me
    if (me) invalidateDevices(me.id)
    set({ backupRestorePrompt: false })
    await get().refreshDmEncryption(me?.id)
  },

  setCurrentChannel(id) {
    // Drafts + reply targets are per-channel and persist; only the transient
    // hover/palette state resets when leaving a channel.
    set((s) => {
      if (id === s.currentChannelId) return { currentChannelId: id }
      return { currentChannelId: id, paletteForMessageId: null, activeMessageId: null }
    })
  },

  async loadMessages(channelId) {
    const prev = get().byChannel[channelId]
    if (prev?.loading) return
    set((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: { ...(prev ?? emptyChannelMessages()), loading: true },
      },
    }))
    try {
      const res = await api.messages(channelId, undefined, PAGE)
      set((s) => ({
        byChannel: {
          ...s.byChannel,
          [channelId]: {
            list: res.messages,
            loaded: true,
            loading: false,
            hasMore: res.messages.length >= PAGE,
          },
        },
      }))
      queueDecryptions(set, res.messages)
    } catch (e) {
      set((s) => ({
        byChannel: {
          ...s.byChannel,
          [channelId]: {
            ...(s.byChannel[channelId] ?? emptyChannelMessages()),
            loading: false,
          },
        },
      }))
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadOlder(channelId) {
    const cm = get().byChannel[channelId]
    if (!cm || cm.loading || !cm.hasMore || cm.list.length === 0) return
    const oldest = cm.list[0].id
    set((s) => ({
      byChannel: { ...s.byChannel, [channelId]: { ...cm, loading: true } },
    }))
    try {
      const res = await api.messages(channelId, oldest, PAGE)
      set((s) => {
        const cur = s.byChannel[channelId] ?? emptyChannelMessages()
        const existing = new Set(cur.list.map((m) => m.id))
        const older = res.messages.filter((m) => !existing.has(m.id))
        return {
          byChannel: {
            ...s.byChannel,
            [channelId]: {
              ...cur,
              list: [...older, ...cur.list],
              loading: false,
              hasMore: res.messages.length >= PAGE,
            },
          },
        }
      })
      queueDecryptions(set, res.messages)
    } catch (e) {
      set((s) => ({
        byChannel: {
          ...s.byChannel,
          [channelId]: {
            ...(s.byChannel[channelId] ?? emptyChannelMessages()),
            loading: false,
          },
        },
      }))
      if (e instanceof Error) toastError(e.message)
    }
  },

  async sendMessage(channelId, content, parentId, attachmentIds, replyToId, encryptedAttachments) {
    try {
      const encrypted = get().isDmEncrypted(channelId)
      const wireContent = encrypted
        ? await encryptDmMessage(channelId, content, encryptedAttachments)
        : content
      const msg = await api.sendMessage(
        channelId,
        wireContent,
        parentId,
        attachmentIds,
        replyToId,
        encrypted || undefined,
      )
      sound.messageSend()
      // Merge immediately; the WS echo will dedupe by id.
      get().applyWsEvent({ type: 'message.created', payload: { message: msg } })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      throw e
    }
  },

  markRead(channelId, messageId) {
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === channelId ? { ...c, unread_count: 0 } : c,
      ),
    }))
    api.markRead(channelId, messageId).catch(() => {
      /* best-effort */
    })
  },

  async createChannel(input) {
    const ch = await api.createChannel(input)
    set((s) => ({
      channels: s.channels.some((c) => c.id === ch.id)
        ? s.channels.map((c) => (c.id === ch.id ? ch : c))
        : [...s.channels, ch],
    }))
    return ch
  },

  async joinChannel(id) {
    await api.joinChannel(id)
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, is_member: true } : c)),
    }))
  },

  async leaveChannel(id) {
    await api.leaveChannel(id)
    set((s) => ({
      channels: s.channels.map((c) => (c.id === id ? { ...c, is_member: false } : c)),
    }))
  },

  async updateChannel(id, input) {
    const ch = await api.updateChannel(id, input)
    // Merge only the mutable fields; the WS echo does the same for others.
    set((s) => ({
      channels: s.channels.map((c) =>
        c.id === id ? { ...c, name: ch.name, topic: ch.topic, kind: ch.kind } : c,
      ),
    }))
    return ch
  },

  async deleteChannel(id) {
    await api.deleteChannel(id)
    // The channel.deleted WS echo removes it; drop optimistically too.
    dropChannel(set, get, id)
  },

  async addChannelMembers(id, userIds) {
    if (userIds.length === 0) return
    await api.addMembers(id, userIds)
    // channel.member_joined events refresh the members cache.
  },

  async removeChannelMember(id, userId) {
    await api.removeMember(id, userId)
    // channel.member_left events refresh the members cache.
  },

  async setMemberRole(channelId, userId, role) {
    const previousMember = get().members[channelId]?.find((member) => member.id === userId)
    const previousChannelRole = get().channels.find((channel) => channel.id === channelId)?.my_role
    const isMe = get().me?.id === userId

    set((s) => ({
      members: s.members[channelId]
        ? {
            ...s.members,
            [channelId]: s.members[channelId].map((member) =>
              member.id === userId ? { ...member, role } : member,
            ),
          }
        : s.members,
      channels: isMe
        ? s.channels.map((channel) =>
            channel.id === channelId ? { ...channel, my_role: role } : channel,
          )
        : s.channels,
    }))

    try {
      await api.setChannelMemberRole(channelId, userId, role)
    } catch (e) {
      set((s) => ({
        members:
          previousMember && s.members[channelId]
            ? {
                ...s.members,
                [channelId]: s.members[channelId].map((member) =>
                  member.id === userId ? { ...member, role: previousMember.role } : member,
                ),
              }
            : s.members,
        channels: isMe
          ? s.channels.map((channel) =>
              channel.id === channelId
                ? { ...channel, my_role: previousChannelRole ?? null }
                : channel,
            )
          : s.channels,
      }))
      if (e instanceof ApiRequestError && e.status === 409) {
        toastError('Cannot demote the last owner.')
      } else if (e instanceof Error) {
        toastError(e.message)
      }
      throw e
    }
  },

  async openDm(userId) {
    const ch = await api.createDm(userId)
    set((s) => ({
      channels: s.channels.some((c) => c.id === ch.id)
        ? s.channels.map((c) => (c.id === ch.id ? ch : c))
        : [...s.channels, ch],
    }))
    void get().refreshDmEncryption(userId)
    return ch
  },

  async loadMembers(id) {
    try {
      const res = await api.members(id)
      set((s) => ({ members: { ...s.members, [id]: res.members } }))
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async toggleReaction(msg, emoji) {
    const existing = msg.reactions.find((r) => r.emoji === emoji)
    const mine = existing?.me ?? false
    const myId = get().me?.id ?? ''
    get().applyReaction(msg.id, msg.channel_id, emoji, myId, !mine)
    if (!mine) sound.reactionAdd()
    try {
      if (mine) await api.removeReaction(msg.id, emoji)
      else await api.addReaction(msg.id, emoji)
    } catch (e) {
      get().applyReaction(msg.id, msg.channel_id, emoji, myId, mine)
      if (e instanceof Error) toastError(e.message)
    }
  },

  applyReaction(messageId, _channelId, emoji, userId, add) {
    const myId = get().me?.id ?? null
    const isMe = myId !== null && userId === myId
    const transform = (m: Message): Message =>
      m.id === messageId
        ? { ...m, reactions: updateReactions(m.reactions, emoji, add, isMe) }
        : m
    set((s) => {
      const byChannel: Record<string, ChannelMessages> = {}
      for (const [cid, cm] of Object.entries(s.byChannel)) {
        byChannel[cid] = { ...cm, list: cm.list.map(transform) }
      }
      let thread = s.thread
      if (s.thread.open) {
        thread = {
          ...s.thread,
          parent: s.thread.parent ? transform(s.thread.parent) : null,
          replies: s.thread.replies.map(transform),
        }
      }
      return { byChannel, thread }
    })
  },

  async editMessage(messageId, content) {
    try {
      const original = findMessage(get(), messageId)
      if (!original) throw new Error('Message not found')
      const wireContent = original.encrypted
        ? await encryptDmMessage(
            original.channel_id,
            content,
            original.attachments
              .filter((attachment) => attachment.decryption)
              .map((attachment) => ({
                id: attachment.id,
                key: attachment.decryption!.key,
                nonce: attachment.decryption!.nonce,
                filename: attachment.filename,
                content_type: attachment.content_type,
              })),
          )
        : content
      const msg = await api.editMessage(messageId, wireContent, original.encrypted || undefined)
      get().applyWsEvent({ type: 'message.updated', payload: { message: msg } })
    } catch (error) {
      if (error instanceof Error) toastError(error.message)
      throw error
    }
  },

  async deleteMessage(messageId) {
    let channelId = ''
    let parentId: string | null = null
    for (const cm of Object.values(get().byChannel)) {
      const m = cm.list.find((x) => x.id === messageId)
      if (m) {
        channelId = m.channel_id
        parentId = m.parent_id
        break
      }
    }
    const th = get().thread
    if (!channelId && th.open) {
      const r = th.replies.find((x) => x.id === messageId)
      if (r) {
        channelId = r.channel_id
        parentId = r.parent_id
      } else if (th.parent?.id === messageId) {
        channelId = th.parent.channel_id
        parentId = th.parent.parent_id
      }
    }
    await api.deleteMessage(messageId)
    get().applyWsEvent({
      type: 'message.deleted',
      payload: { message_id: messageId, channel_id: channelId, parent_id: parentId },
    })
  },

  async createPoll(channelId, input) {
    const poll = await api.polls.create(channelId, input)
    set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    return poll
  },

  async votePoll(pollId, optionIds) {
    const original = get().pollsById[pollId]
    const me = get().me
    if (!original || !me || original.closed_at || original.deleted) return
    const optimistic = withPollVotes(original, optionIds, me.id, me.display_name)
    set((s) => ({ pollsById: { ...s.pollsById, [pollId]: optimistic } }))
    try {
      const poll = await api.polls.vote(pollId, optionIds)
      set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    } catch (error) {
      set((s) => ({ pollsById: { ...s.pollsById, [pollId]: original } }))
      toastError(error instanceof Error ? error.message : 'Could not update vote.')
    }
  },

  async retractVote(pollId) {
    const original = get().pollsById[pollId]
    const me = get().me
    if (!original || !me || original.closed_at || original.deleted) return
    set((s) => ({
      pollsById: {
        ...s.pollsById,
        [pollId]: withPollVotes(original, [], me.id, me.display_name),
      },
    }))
    try {
      const poll = await api.polls.retract(pollId)
      set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    } catch (error) {
      set((s) => ({ pollsById: { ...s.pollsById, [pollId]: original } }))
      toastError(error instanceof Error ? error.message : 'Could not retract vote.')
    }
  },

  async closePoll(pollId) {
    try {
      const poll = await api.polls.close(pollId)
      set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not close poll.')
    }
  },

  async pinPoll(pollId, pinned) {
    try {
      const poll = await api.polls.pin(pollId, pinned)
      set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    } catch (error) {
      toastError(error instanceof Error ? error.message : 'Could not update poll pin.')
    }
  },

  async deletePoll(pollId) {
    const original = get().pollsById[pollId]
    set((s) => {
      const pollsById = { ...s.pollsById }
      delete pollsById[pollId]
      return { pollsById }
    })
    try {
      await api.polls.delete(pollId)
    } catch (error) {
      if (original) {
        set((s) => ({ pollsById: { ...s.pollsById, [pollId]: original } }))
      }
      toastError(error instanceof Error ? error.message : 'Could not delete poll.')
    }
  },

  async fetchPoll(pollId) {
    const poll = await api.polls.get(pollId)
    set((s) => ({ pollsById: { ...s.pollsById, [poll.id]: poll } }))
    return poll
  },

  async fetchActivePolls(channelId) {
    const { polls } = await api.polls.listActive(channelId)
    set((s) => {
      const pollsById = { ...s.pollsById }
      for (const [id, poll] of Object.entries(pollsById)) {
        if (poll.channel_id === channelId && !poll.closed_at && !poll.deleted) delete pollsById[id]
      }
      for (const poll of polls) pollsById[poll.id] = poll
      return { pollsById }
    })
  },

  createCallPoll(input) {
    const state = get()
    const roomId = state.voice.channelId
    if (!roomId || state.isGuest) return
    state.ws?.send('voice.poll_create', { room_id: roomId, ...input })
  },

  voteCallPoll(pollId, optionIds) {
    const state = get()
    if (!state.voice.channelId) return
    state.ws?.send('voice.poll_vote', {
      room_id: state.voice.channelId,
      poll_id: pollId,
      option_ids: optionIds,
    })
  },

  closeCallPoll(pollId) {
    const state = get()
    if (!state.voice.channelId) return
    state.ws?.send('voice.poll_close', {
      room_id: state.voice.channelId,
      poll_id: pollId,
    })
  },

  async openThread(parentId) {
    set({ thread: { open: true, parentId, parent: null, replies: [], loading: true } })
    try {
      const res = await api.thread(parentId)
      set((s) =>
        s.thread.parentId === parentId
          ? {
              thread: {
                open: true,
                parentId,
                parent: res.parent,
                replies: res.replies,
                loading: false,
              },
            }
          : s,
      )
      queueDecryptions(set, [res.parent, ...res.replies])
    } catch (e) {
      set({ thread: { open: false, parentId: null, parent: null, replies: [], loading: false } })
      if (e instanceof Error) toastError(e.message)
    }
  },

  closeThread() {
    set({ thread: { open: false, parentId: null, parent: null, replies: [], loading: false } })
  },

  setQuickSwitcher(open) {
    set({ quickSwitcherOpen: open })
  },

  setSearchOpen(open) {
    set({ searchOpen: open })
  },

  setInboxOpen(open) {
    set({ inboxOpen: open })
  },

  // --- Sharpy: AI workspace assistant ---

  async initSharpy() {
    if (get().sharpyStatusChecked) return
    try {
      const { enabled } = await api.sharpy.status()
      set({ sharpyEnabled: enabled, sharpyStatusChecked: true })
      if (!enabled) return
      const conversations = await api.sharpy.conversations()
      set({ sharpyConversations: conversations })
    } catch {
      // Feature stays disabled if status can't be resolved; never blocks boot.
      set({ sharpyStatusChecked: true })
    }
  },

  setSharpyOpen(open) {
    set({ sharpyOpen: open })
  },

  async openSharpyConversation(id) {
    set({ sharpyActiveId: id, sharpyLoading: true, sharpyMessages: [] })
    try {
      const { conversation, messages } = await api.sharpy.conversation(id)
      // Ignore a stale response if the user switched conversations meanwhile.
      if (get().sharpyActiveId !== id) return
      set((s) => ({
        sharpyMessages: messages,
        sharpyLoading: false,
        sharpyConversations: s.sharpyConversations.some((c) => c.id === conversation.id)
          ? s.sharpyConversations.map((c) => (c.id === conversation.id ? conversation : c))
          : [conversation, ...s.sharpyConversations],
      }))
    } catch (e) {
      if (get().sharpyActiveId === id) set({ sharpyLoading: false })
      if (e instanceof Error) toastError(e.message)
    }
  },

  newSharpyConversation() {
    // A fresh conversation is created lazily on the first send.
    set({ sharpyActiveId: null, sharpyMessages: [], sharpyStreamText: '', sharpyStreamSources: null })
  },

  async deleteSharpyConversation(id) {
    const prev = get().sharpyConversations
    set((s) => ({
      sharpyConversations: s.sharpyConversations.filter((c) => c.id !== id),
      ...(s.sharpyActiveId === id
        ? { sharpyActiveId: null, sharpyMessages: [] }
        : {}),
    }))
    try {
      await api.sharpy.deleteConversation(id)
    } catch (e) {
      set({ sharpyConversations: prev })
      if (e instanceof Error) toastError(e.message)
    }
  },

  async sendSharpy(content) {
    const text = content.trim()
    if (!text || get().sharpyStreaming || !get().sharpyEnabled) return

    // Create a conversation on the fly when none is active.
    let conversationId = get().sharpyActiveId
    if (!conversationId) {
      try {
        const conversation = await api.sharpy.createConversation()
        conversationId = conversation.id
        set((s) => ({
          sharpyActiveId: conversation.id,
          sharpyMessages: [],
          sharpyConversations: [conversation, ...s.sharpyConversations],
        }))
      } catch (e) {
        if (e instanceof Error) toastError(e.message)
        return
      }
    }

    const optimisticUser: SharpyMessage = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      sources: null,
      created_at: new Date().toISOString(),
    }
    set((s) => ({
      sharpyMessages: [...s.sharpyMessages, optimisticUser],
      sharpyStreaming: true,
      sharpyStreamText: '',
      sharpyStreamSources: null,
    }))

    await api.sharpy.send(conversationId, text, {
      onSources: (sources) => {
        if (get().sharpyActiveId !== conversationId) return
        set({ sharpyStreamSources: sources })
      },
      onDelta: (delta) => {
        if (get().sharpyActiveId !== conversationId) return
        set((s) => ({ sharpyStreamText: s.sharpyStreamText + delta }))
      },
      onDone: (message) => {
        set((s) => {
          const stillActive = s.sharpyActiveId === conversationId
          return {
            sharpyStreaming: false,
            sharpyStreamText: '',
            sharpyStreamSources: null,
            sharpyMessages: stillActive ? [...s.sharpyMessages, message] : s.sharpyMessages,
          }
        })
        // Refresh list ordering + server-generated title after the exchange.
        void api.sharpy
          .conversations()
          .then((conversations) => set({ sharpyConversations: conversations }))
          .catch(() => {})
      },
      onError: (errMessage) => {
        set({ sharpyStreaming: false, sharpyStreamText: '', sharpyStreamSources: null })
        toastError(errMessage)
      },
    })
    // Safety net if the stream ends without a terminal frame.
    if (get().sharpyStreaming) {
      set({ sharpyStreaming: false, sharpyStreamText: '', sharpyStreamSources: null })
    }
  },

  setDraft(key, text) {
    set((s) => {
      const drafts = { ...s.drafts }
      if (text) drafts[key] = text
      else delete drafts[key]
      return { drafts }
    })
  },

  setReplyTarget(channelId, msg) {
    set((s) => {
      const replyTargets = { ...s.replyTargets }
      if (msg) replyTargets[channelId] = msg
      else delete replyTargets[channelId]
      return { replyTargets }
    })
  },

  requestComposerFocus(key) {
    set((s) => ({ focusRequest: { key, n: (s.focusRequest?.n ?? 0) + 1 } }))
  },

  setActiveMessage(id) {
    set({ activeMessageId: id })
  },

  setPaletteFor(id) {
    set({ paletteForMessageId: id })
  },

  setFocus(focus) {
    set({ focus })
  },

  sendTyping(channelId) {
    get().ws?.sendTyping(channelId)
  },

  pruneTyping() {
    const now = Date.now()
    const cur = get().typing
    let changed = false
    const next: Record<string, Record<string, TypingEntry>> = {}
    for (const [ch, users] of Object.entries(cur)) {
      const kept: Record<string, TypingEntry> = {}
      for (const [uid, e] of Object.entries(users)) {
        if (e.expiresAt > now) kept[uid] = e
        else changed = true
      }
      if (Object.keys(kept).length) next[ch] = kept
    }
    if (changed) set({ typing: next })
  },

  async joinVoice(channelId, opts) {
    if (get().voice.channelId) get().leaveVoice()

    const { me, myConnId, ws } = get()
    if (!me || !myConnId || !ws) {
      toastError('Voice is not available until the connection is ready.')
      return
    }

    const videoBackground = loadVideoBackground(me.id)
    const devicePrefs = loadVoiceDevicePrefs(me.id)
    set({
      callPoll: null,
      voice: {
        channelId,
        status: 'connecting',
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
        stageMode: opts?.stageMode ?? 'expanded',
        audioDeviceId: devicePrefs.audioDeviceId,
        videoDeviceId: devicePrefs.videoDeviceId,
        localStream: null,
        remoteStreams: {},
        localScreenStream: null,
        remoteScreenStreams: {},
        client: null,
        annotationsAllowed: false,
        annotating: false,
      },
    })
    annotations.reset()
    annotations.setSend(
      (payload) => get().ws?.send('voice.annotate', { channel_id: channelId, ...payload }),
      myConnId,
    )

    try {
      const config = await api.voice.config()
      const pending = get().voice
      if (pending.channelId !== channelId || pending.status !== 'connecting' || pending.client) {
        return
      }
      if (!config.available) throw new Error('Video calls are not configured on this server.')
      set((state) => ({
        voice: { ...state.voice, transcriptionAvailable: config.transcription },
      }))
      ws.send('voice.join', {
        channel_id: channelId,
        ...(opts?.linkToken ? { link_token: opts.linkToken } : {}),
      })
    } catch (error) {
      if (get().voice.channelId === channelId) {
        annotations.reset()
        annotations.setSend(null, null)
        set({ voice: emptyVoiceState(), callPoll: null })
      }
      toastError(error instanceof Error ? error.message : 'Could not join the voice room.')
    }
  },

  async connectVoiceMedia(payload) {
    const media = payload.media
    const current = get()
    const { me, myConnId } = current
    if (
      !media ||
      !me ||
      !myConnId ||
      media.participant_identity !== myConnId ||
      current.voice.channelId !== payload.channel_id ||
      current.voice.status !== 'connecting' ||
      current.voice.client
    ) {
      return
    }

    let VoiceClientImpl: typeof import('./lib/voice').VoiceClient
    try {
      const voiceModule = await import('./lib/voice')
      VoiceClientImpl = voiceModule.VoiceClient
    } catch {
      if (get().voice.channelId === payload.channel_id && !get().voice.client) {
        get().ws?.send('voice.leave', { channel_id: payload.channel_id })
        annotations.reset()
        annotations.setSend(null, null)
        set({ voice: emptyVoiceState(), callPoll: null })
        toastError('Could not load call media.')
      }
      return
    }
    const latest = get()
    if (
      latest.voice.channelId !== payload.channel_id ||
      latest.voice.status !== 'connecting' ||
      latest.voice.client
    ) {
      return
    }

    let client: VoiceClient | null = null
    client = new VoiceClientImpl({
      channelId: payload.channel_id,
      myConnId,
      serverUrl: media.server_url,
      participantToken: media.participant_token,
      noiseSuppression: current.voice.noiseSuppression,
      videoBackground: current.voice.videoBackground,
      audioDeviceId: current.voice.audioDeviceId,
      videoDeviceId: current.voice.videoDeviceId,
      send: (type, eventPayload) => get().ws?.send(type, eventPayload),
      onSpeaking: (connId, speaking) => {
        set((state) => {
          if (state.voice.client !== client) return {}
          return {
            voice: {
              ...state.voice,
              speaking: { ...state.voice.speaking, [connId]: speaking },
            },
          }
        })
      },
      onLocalStream: (stream) => {
        set((state) => {
          const activeClient = state.voice.client
          if (!activeClient || activeClient !== client) return {}
          return {
            voice: {
              ...state.voice,
              localStream: stream,
              cameraStatus: stream ? 'on' : 'off',
              videoDeviceId: activeClient.getVideoDeviceId() ?? state.voice.videoDeviceId,
            },
          }
        })
      },
      onRemoteStream: (connId, stream) => {
        set((state) => {
          if (state.voice.client !== client) return {}
          const remoteStreams = { ...state.voice.remoteStreams }
          if (stream?.getVideoTracks().length) remoteStreams[connId] = stream
          else delete remoteStreams[connId]
          return { voice: { ...state.voice, remoteStreams } }
        })
      },
      onLocalScreen: (stream) => {
        set((state) => {
          if (state.voice.client !== client) return {}
          return {
            voice: {
              ...state.voice,
              localScreenStream: stream,
              screenStatus: stream ? 'on' : 'off',
            },
            // Reveal grants are scoped to one sharing session: any share
            // start/stop drops them, so a new session always begins shielded
            // (call-leave paths reset voice without this callback, so clearing
            // on start covers stale grants too).
            streamRevealAllUntil: null,
            streamRevealChannels: {},
          }
        })
      },
      onRemoteScreen: (connId, stream) => {
        set((state) => {
          if (state.voice.client !== client) return {}
          const remoteScreenStreams = { ...state.voice.remoteScreenStreams }
          if (stream?.getVideoTracks().length) remoteScreenStreams[connId] = stream
          else delete remoteScreenStreams[connId]
          return { voice: { ...state.voice, remoteScreenStreams } }
        })
      },
      onNoiseSuppression: (available) => {
        set((state) => {
          if (state.voice.client !== client) return {}
          return { voice: { ...state.voice, noiseSuppressionAvailable: available } }
        })
      },
      onConnectionState: (connectionState) => {
        if (get().voice.client !== client) return
        if (connectionState === 'disconnected') {
          get().ws?.send('voice.leave', { channel_id: payload.channel_id })
          client?.stop()
          annotations.reset()
          annotations.setSend(null, null)
          set({ voice: emptyVoiceState(), callPoll: null })
          toastError('Call media disconnected. Rejoin the call to continue.')
          return
        }
        set((state) => ({
          voice: {
            ...state.voice,
            status: connectionState,
          },
        }))
      },
    })
    set((state) => ({ voice: { ...state.voice, client } }))

    try {
      await client.start()
      const active = get().voice
      if (active.channelId !== payload.channel_id || active.client !== client) {
        client.stop()
        return
      }
      set((state) => ({
        voice: {
          ...state.voice,
          status: 'connected',
          audioDeviceId: client?.getAudioDeviceId() ?? state.voice.audioDeviceId,
        },
      }))
      client.syncPeers(payload.participants)
      playVoiceJoinSound()
    } catch (error) {
      client.stop()
      if (get().voice.client === client) {
        get().ws?.send('voice.leave', { channel_id: payload.channel_id })
        annotations.reset()
        annotations.setSend(null, null)
        set({ voice: emptyVoiceState(), callPoll: null })
        toastError(
          error instanceof Error && error.message
            ? error.message
            : 'Could not connect to call media.',
        )
      }
    }
  },

  leaveVoice() {
    const { channelId, client, status } = get().voice
    if (channelId) get().ws?.send('voice.leave', { channel_id: channelId })
    stopVoiceRecognizer()
    client?.stop()
    annotations.reset()
    annotations.setSend(null, null)
    set({ voice: emptyVoiceState(), callPoll: null })
    if (channelId && status === 'connected') playVoiceLeaveSound()
  },

  toggleVoiceMute() {
    const { channelId, client, muted, handRaised } = get().voice
    if (!channelId || !client) return
    const nextMuted = !muted
    client.setMuted(nextMuted)
    if (nextMuted) sound.micMute()
    else sound.micUnmute()
    // Unmuting optimistically lowers a raised hand; the server confirms via the
    // participant_updated echo it broadcasts for the mute change.
    const lowerHand = !nextMuted && handRaised
    set((s) => ({
      voice: { ...s.voice, muted: nextMuted, handRaised: lowerHand ? false : s.voice.handRaised },
    }))
    if (get().voice.transcribing) {
      if (nextMuted) voiceRecognizer?.pause()
      else voiceRecognizer?.resume()
    }
    get().ws?.send('voice.mute', { channel_id: channelId, muted: nextMuted })
  },

  // Purely local mic denoising — no WS event; peers only hear the cleaned track.
  async toggleNoiseSuppression() {
    const next = !get().voice.noiseSuppression
    try {
      window.localStorage.setItem(NOISE_SUPPRESSION_KEY, next ? '1' : '0')
    } catch {
      // ignore persistence failures (private mode etc.)
    }
    set((s) => ({ voice: { ...s.voice, noiseSuppression: next } }))
    const { client } = get().voice
    if (!client) return
    await client.setNoiseSuppression(next)
  },

  // Purely local camera effect — no WS event. Persisted per user; live cameras
  // swap their published track in place without dropping the call.
  async setVoiceVideoBackground(background) {
    const userId = get().me?.id
    if (userId && !saveVideoBackground(userId, background)) {
      toastError('Background applied, but this browser could not save it.')
    }
    set((s) => ({
      voice: {
        ...s.voice,
        videoBackground: background,
      },
    }))
    const { client } = get().voice
    if (!client) return
    try {
      await client.setVideoBackground(background)
    } catch {
      toastError('Could not change camera background.')
    }
  },

  toggleVoiceHand() {
    const { channelId, client, status, handRaised } = get().voice
    if (!channelId || !client || status !== 'connected') return
    const nextRaised = !handRaised
    if (nextRaised) sound.handRaise()
    set((s) => ({ voice: { ...s.voice, handRaised: nextRaised } }))
    get().ws?.send('voice.hand', { channel_id: channelId, raised: nextRaised })
  },

  toggleTranscription() {
    const { voice, ws } = get()
    if (
      !voice.transcriptionAvailable ||
      !isTranscriptionSupported() ||
      !voice.channelId ||
      voice.status !== 'connected'
    ) {
      return
    }

    const channelId = voice.channelId
    if (voice.transcribing) {
      stopVoiceRecognizer()
      set((s) => ({ voice: { ...s.voice, transcribing: false } }))
      ws?.send('voice.transcribe', { channel_id: channelId, enabled: false })
      return
    }

    stopVoiceRecognizer()
    const recognizer = new PhraseRecognizer({
      deviceId: voice.audioDeviceId,
      onPhrase: (text) => {
        const current = get()
        if (!current.voice.transcribing || current.voice.channelId !== channelId) return
        current.ws?.send('voice.phrase', { channel_id: channelId, text })
      },
      onError: (error) => {
        if (voiceRecognizer !== recognizer) return
        voiceRecognizer = null
        const current = get()
        if (!current.voice.transcribing || current.voice.channelId !== channelId) return
        set((s) => ({ voice: { ...s.voice, transcribing: false } }))
        current.ws?.send('voice.transcribe', { channel_id: channelId, enabled: false })
        toastError(
          error === 'not-allowed'
            ? 'Microphone permission was denied for live transcription.'
            : 'Live transcription service is unavailable.',
        )
      },
    })
    voiceRecognizer = recognizer
    set((s) => ({ voice: { ...s.voice, transcribing: true } }))
    recognizer.start()
    if (voice.muted) recognizer.pause()
    ws?.send('voice.transcribe', { channel_id: channelId, enabled: true })
  },

  toggleVoiceCamera() {
    const { channelId, client, status, cameraStatus } = get().voice
    if (!channelId || !client || status !== 'connected' || cameraStatus === 'starting') return
    if (cameraStatus === 'on') {
      client.stopCamera()
      sound.cameraOff()
      get().ws?.send('voice.camera', { channel_id: channelId, enabled: false })
      return
    }
    sound.cameraOn()
    set((s) => ({ voice: { ...s.voice, cameraStatus: 'starting' } }))
    get().ws?.send('voice.camera', { channel_id: channelId, enabled: true })
  },

  async toggleVoiceScreen() {
    const { channelId, client, status, screenStatus } = get().voice
    if (!channelId || !client || status !== 'connected' || screenStatus === 'starting') return
    if (screenStatus === 'on') {
      client.stopScreenShare()
      sound.screenShareStop()
      get().ws?.send('voice.screen', { channel_id: channelId, enabled: false })
      return
    }
    set((s) => ({ voice: { ...s.voice, screenStatus: 'starting' } }))
    let streamId: string
    try {
      // Acquire in the click gesture (getDisplayMedia needs transient user
      // activation); publish only once the server echoes participant_updated.
      streamId = await client.acquireScreen()
      sound.screenShareStart()
    } catch {
      // Picker cancelled / permission denied — reset silently.
      if (get().voice.client === client) {
        set((s) => ({ voice: { ...s.voice, screenStatus: 'off' } }))
      }
      return
    }
    if (get().voice.client !== client) {
      client.stopScreenShare()
      return
    }
    get().ws?.send('voice.screen', {
      channel_id: channelId,
      enabled: true,
      stream_id: streamId,
    })
  },

  async setVoiceAudioDevice(deviceId) {
    const { channelId, client } = get().voice
    if (!channelId || !client) return
    try {
      await client.setAudioInput(deviceId)
      if (get().voice.client !== client) return
      const activeId = client.getAudioDeviceId()
      const me = get().me
      if (me) saveVoiceAudioDevice(me.id, activeId)
      set((s) => ({
        voice: { ...s.voice, audioDeviceId: activeId },
      }))
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      else toastError('Could not switch microphone.')
    }
  },

  async setVoiceVideoDevice(deviceId) {
    const { channelId, client } = get().voice
    if (!channelId || !client) return
    try {
      await client.setVideoInput(deviceId)
      if (get().voice.client !== client) return
      const activeId = client.getVideoDeviceId()
      const me = get().me
      if (me) saveVoiceVideoDevice(me.id, activeId)
      set((s) => ({
        voice: { ...s.voice, videoDeviceId: activeId },
      }))
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      else toastError('Could not switch camera.')
    }
  },

  setVoiceStageMode(mode) {
    if (!get().voice.channelId) return
    set((s) => ({ voice: { ...s.voice, stageMode: mode } }))
  },

  toggleAnnotating() {
    if (!get().voice.channelId) return
    set((s) => ({ voice: { ...s.voice, annotating: !s.voice.annotating } }))
  },

  setAnnotationsAllowed(allowed) {
    const { channelId } = get().voice
    if (!channelId) return
    // Sharer-only on the server; the resulting voice.annotate_state event flips
    // the local flag, so we don't set it optimistically here.
    get().ws?.send('voice.annotate_allow', { channel_id: channelId, allowed })
  },

  clearAnnotations() {
    const { channelId } = get().voice
    if (!channelId) return
    get().ws?.send('voice.annotate_clear', { channel_id: channelId })
    annotations.clearAll()
  },

  totalUnread() {
    return get().channels.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  },

  // --- docs ---

  async loadChannelDocs(channelId) {
    try {
      const res = await api.channelDocs(channelId)
      set((s) => {
        const docMeta = { ...s.docMeta }
        for (const d of res.docs) docMeta[d.id] = d
        const docsLoaded = new Set(s.docsLoaded)
        docsLoaded.add(channelId)
        return {
          docsByChannel: { ...s.docsByChannel, [channelId]: sortDocs(res.docs) },
          docsLoaded,
          docMeta,
        }
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadChannelTrash(channelId) {
    try {
      const res = await api.channelDocsTrash(channelId)
      set((s) => {
        const docMeta = { ...s.docMeta }
        for (const d of res.docs) docMeta[d.id] = d
        return {
          trashByChannel: { ...s.trashByChannel, [channelId]: sortDocs(res.docs) },
          docMeta,
        }
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async createDoc(channelId, input = {}) {
    const doc = await api.createDoc(channelId, input)
    set((s) => placeDoc(s, doc))
    return doc
  },

  async createCanvas(channelId, input = {}) {
    return get().createDoc(channelId, { ...input, kind: 'canvas' })
  },

  async createBoard(channelId, input = {}) {
    return get().createDoc(channelId, { ...input, kind: 'board' })
  },

  async fetchDoc(id) {
    const doc = await api.getDoc(id)
    set((s) => ({ docMeta: { ...s.docMeta, [id]: doc } }))
    return doc
  },

  async patchDoc(id, input) {
    const doc = await api.patchDoc(id, input)
    set((s) => placeDoc(s, doc))
    return doc
  },

  async trashDoc(id) {
    await api.deleteDoc(id)
    // Optimistic local move; the doc.deleted WS event confirms.
    set((s) => {
      const existing = s.docMeta[id]
      if (!existing) return s
      return placeDoc(s, { ...existing, deleted_at: new Date().toISOString() })
    })
  },

  async restoreDoc(id) {
    const doc = await api.restoreDoc(id)
    set((s) => placeDoc(s, doc))
    return doc
  },

  async permanentDeleteDoc(id) {
    await api.permanentDeleteDoc(id)
    set((s) => removeDoc(s, id))
  },

  async loadMentions() {
    try {
      const res = await api.mentions()
      set({
        mentions: res.mentions,
        unreadMentionCount: countUnread(res.mentions),
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  // --- tasks (Phase 7) ---

  async loadProjects() {
    try {
      const res = await api.tasks.projects()
      set({ projects: res.projects })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadTaskLabels() {
    try {
      const res = await api.tasks.labels()
      set({ taskLabels: res.labels })
    } catch {
      /* non-fatal */
    }
  },

  async loadProjectTasks(projectId) {
    try {
      const res = await api.tasks.list(projectId)
      set((s) => ({
        tasksByProject: { ...s.tasksByProject, [projectId]: res.tasks },
      }))
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadMyTasks() {
    try {
      const res = await api.tasks.mine()
      set({ myTasks: res.tasks })
    } catch {
      /* non-fatal */
    }
  },

  async loadTaskDetail(taskId) {
    const detail = await api.tasks.get(taskId)
    set((s) => ({ taskDetails: { ...s.taskDetails, [taskId]: detail } }))
    return detail
  },

  setActiveProject(projectId) {
    set({ activeProjectId: projectId })
  },

  async patchTask(taskId, patch) {
    // Optimistic: merge scalar fields into every cached copy, then PATCH. The
    // authoritative task comes back on the task.updated broadcast.
    set((s) => {
      const apply = (t: Task): Task => (t.id === taskId ? { ...t, ...patch } as Task : t)
      const tasksByProject = Object.fromEntries(
        Object.entries(s.tasksByProject).map(([pid, list]) => [
          pid,
          sortTasks(list.map(apply)),
        ]),
      )
      return { tasksByProject, myTasks: s.myTasks.map(apply) }
    })
    try {
      await api.tasks.update(taskId, patch)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
      const pid = get().activeProjectId
      if (pid) void get().loadProjectTasks(pid)
      void get().loadMyTasks()
    }
  },

  async loadCalendar(from, to) {
    try {
      const res = await api.calendar.events(from, to)
      set({ calendarItems: res.events, calendarRange: { from, to } })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadCalendarConnections() {
    try {
      const res = await api.calendar.connections()
      set({ calendarConnections: res.connections })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async createScheduledMeeting(input) {
    const meeting = await api.calendar.meetings.create(input)
    set((s) => ({
      calendarItems: upsertMeetingItem(s.calendarItems, s.calendarRange, meeting),
    }))
    return meeting
  },

  async updateScheduledMeeting(id, input) {
    const meeting = await api.calendar.meetings.update(id, input)
    set((s) => ({
      calendarItems: upsertMeetingItem(s.calendarItems, s.calendarRange, meeting),
    }))
    return meeting
  },

  async cancelScheduledMeeting(id) {
    await api.calendar.meetings.cancel(id)
    set((s) => ({
      calendarItems: s.calendarItems.filter(
        (i) => !(i.source === 'native' && i.meeting.id === id),
      ),
    }))
  },

  async rsvpMeeting(id, response) {
    await api.calendar.meetings.rsvp(id, response)
    const myId = get().me?.id ?? null
    set((s) => ({
      calendarItems: s.calendarItems.map((i) =>
        i.source === 'native' && i.meeting.id === id
          ? { ...i, meeting: applyMyRsvp(i.meeting, myId, response) }
          : i,
      ),
    }))
  },

  setCalendarSelectedDate(dayKey) {
    set({ calendarSelectedDate: dayKey })
  },

  joinScheduledMeeting(joinPath) {
    if (!joinPath) return
    const channelMatch = joinPath.match(/^\/c\/([^/]+)/)
    navigateTo(joinPath)
    if (channelMatch) void get().joinVoice(channelMatch[1])
  },

  async loadInboxAndPrefs() {
    try {
      const [inbox, prefs, nickRes] = await Promise.all([
        api.notifications(),
        api.prefs(),
        api.nicknames(),
      ])
      set({
        notifications: inbox.notifications,
        notifUnread: inbox.unread_count,
        notifHasMore: inbox.notifications.length >= 30,
        dnd: prefs.dnd,
        mutedChannels: new Set(prefs.muted_channel_ids),
        channelModes: prefs.channel_modes ?? {},
        notifyDm: prefs.notify_dm,
        notifyMention: prefs.notify_mention,
        notifyReply: prefs.notify_reply,
        notifyTask: prefs.notify_task,
        notifyPoll: prefs.notify_poll,
        dndScheduled: prefs.dnd_scheduled,
        dndStart: prefs.dnd_start,
        dndEnd: prefs.dnd_end,
        tzOffset: prefs.tz_offset,
        chatLayout: prefs.chat_layout,
        nicknames: nickRes.nicknames ?? {},
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async setNickname(userId, nickname) {
    const trimmed = nickname.trim()
    if (!trimmed) {
      await get().clearNickname(userId)
      return
    }
    const prev = get().nicknames
    set({ nicknames: { ...prev, [userId]: trimmed } })
    try {
      await api.setNickname(userId, trimmed)
    } catch (e) {
      set({ nicknames: prev })
      if (e instanceof Error) toastError(e.message)
      throw e
    }
  },

  async clearNickname(userId) {
    const prev = get().nicknames
    if (!(userId in prev)) {
      await api.deleteNickname(userId).catch(() => {})
      return
    }
    const next = { ...prev }
    delete next[userId]
    set({ nicknames: next })
    try {
      await api.deleteNickname(userId)
    } catch (e) {
      set({ nicknames: prev })
      if (e instanceof Error) toastError(e.message)
      throw e
    }
  },

  async setChatLayout(layout) {
    const prev = get().chatLayout
    set({ chatLayout: layout })
    try {
      await api.setChatLayout(layout)
    } catch (e) {
      set({ chatLayout: prev })
      if (e instanceof Error) toastError(e.message)
    }
  },

  setRailPosition(position) {
    set({ railPosition: position })
    try {
      window.localStorage.setItem(RAIL_POSITION_KEY, position)
    } catch {
      // The preference is still usable for this session if storage is unavailable.
    }
  },

  setDockAutoHide(autoHide) {
    set({ dockAutoHide: autoHide })
    try {
      window.localStorage.setItem(DOCK_AUTOHIDE_KEY, autoHide ? '1' : '0')
    } catch {
      // The preference is still usable for this session if storage is unavailable.
    }
  },

  setStreamManual(on) {
    // Turning the mode off also drops any reveal grants so re-arming starts shielded.
    set({
      streamManual: on,
      ...(on ? {} : { streamRevealAllUntil: null, streamRevealChannels: {} }),
    })
    try {
      window.localStorage.setItem(STREAM_MANUAL_KEY, on ? '1' : '0')
    } catch {
      // The preference is still usable for this session if storage is unavailable.
    }
  },

  setStreamRevertNicknames(on) {
    set({ streamRevertNicknames: on })
    try {
      window.localStorage.setItem(STREAM_REVERT_NICKS_KEY, on ? '1' : '0')
    } catch {
      // The preference is still usable for this session if storage is unavailable.
    }
  },

  revealStreamAll() {
    set({ streamRevealAllUntil: Date.now() + 10 * 60_000 })
  },

  revealStreamChannel(channelId) {
    set((s) => ({
      streamRevealChannels: {
        ...s.streamRevealChannels,
        [channelId]: Date.now() + 10 * 60_000,
      },
    }))
  },

  clearStreamReveals() {
    set({ streamRevealAllUntil: null, streamRevealChannels: {} })
  },

  // Prune lapsed reveal windows so subscribers re-render and re-blur the moment
  // a window expires (called from the banner's 1s tick while any window is open).
  expireStreamReveals() {
    const s = get()
    const now = Date.now()
    const allLapsed = s.streamRevealAllUntil !== null && s.streamRevealAllUntil <= now
    const lapsedChannels = Object.entries(s.streamRevealChannels).filter(([, t]) => t <= now)
    if (!allLapsed && lapsedChannels.length === 0) return
    const streamRevealChannels = { ...s.streamRevealChannels }
    for (const [id] of lapsedChannels) delete streamRevealChannels[id]
    set({
      ...(allLapsed ? { streamRevealAllUntil: null } : {}),
      streamRevealChannels,
    })
  },

  async updateProfile(input) {
    const user = await api.updateProfile(input)
    set((s) => ({ me: user, users: { ...s.users, [user.id]: user } }))
  },

  async uploadAvatar(file, onProgress) {
    const user = await api.uploadAvatar(file, onProgress)
    set((s) => ({ me: user, users: { ...s.users, [user.id]: user } }))
  },

  async removeAvatar() {
    const user = await api.deleteAvatar()
    set((s) => ({ me: user, users: { ...s.users, [user.id]: user } }))
  },

  async markMentionsRead(ids) {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const now = new Date().toISOString()
    set((s) => {
      const mentions = s.mentions.map((m) =>
        idSet.has(m.id) && !m.read_at ? { ...m, read_at: now } : m,
      )
      return { mentions, unreadMentionCount: countUnread(mentions) }
    })
    try {
      await api.markMentionsRead(ids)
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  async loadMoreNotifications() {
    const cur = get().notifications
    if (cur.length === 0) return
    const before = cur[cur.length - 1].id
    try {
      const res = await api.notifications(before)
      set((s) => {
        const seen = new Set(s.notifications.map((n) => n.id))
        const older = res.notifications.filter((n) => !seen.has(n.id))
        return {
          notifications: [...s.notifications, ...older],
          notifHasMore: res.notifications.length >= 30,
        }
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
    }
  },

  markNotifRead(id) {
    set((s) => {
      const n = s.notifications.find((x) => x.id === id)
      const wasUnread = !!n && !n.read_at
      return {
        notifications: s.notifications.map((x) =>
          x.id === id ? { ...x, read_at: x.read_at ?? new Date().toISOString() } : x,
        ),
        notifUnread: wasUnread ? Math.max(0, s.notifUnread - 1) : s.notifUnread,
      }
    })
    api.markNotificationsRead({ ids: [id] }).catch(() => {})
  },

  markAllNotifRead() {
    const now = new Date().toISOString()
    set((s) => ({
      notifications: s.notifications.map((n) => (n.read_at ? n : { ...n, read_at: now })),
      notifUnread: 0,
    }))
    api.markNotificationsRead({ all: true }).catch(() => {})
  },

  markChannelNotifsRead(channelId) {
    const ids = get()
      .notifications.filter((n) => !n.read_at && n.channel_id === channelId)
      .map((n) => n.id)
    if (ids.length === 0) return
    const idSet = new Set(ids)
    const now = new Date().toISOString()
    set((s) => ({
      notifications: s.notifications.map((n) =>
        idSet.has(n.id) ? { ...n, read_at: n.read_at ?? now } : n,
      ),
      notifUnread: Math.max(0, s.notifUnread - ids.length),
    }))
    api.markNotificationsRead({ ids }).catch(() => {})
  },

  async setDnd(dnd) {
    set({ dnd })
    try {
      await api.setDnd(dnd)
    } catch (e) {
      set({ dnd: !dnd })
      if (e instanceof Error) toastError(e.message)
    }
  },

  async updateNotifyPrefs(patch) {
    // Optimistic: apply the camelCase mirror of the snake_case wire patch.
    const prev = get()
    const next: Partial<State> = {}
    if (patch.notify_dm !== undefined) next.notifyDm = patch.notify_dm
    if (patch.notify_mention !== undefined) next.notifyMention = patch.notify_mention
    if (patch.notify_reply !== undefined) next.notifyReply = patch.notify_reply
    if (patch.notify_task !== undefined) next.notifyTask = patch.notify_task
    if (patch.notify_poll !== undefined) next.notifyPoll = patch.notify_poll
    if (patch.dnd_scheduled !== undefined) next.dndScheduled = patch.dnd_scheduled
    if (patch.dnd_start !== undefined) next.dndStart = patch.dnd_start
    if (patch.dnd_end !== undefined) next.dndEnd = patch.dnd_end
    if (patch.tz_offset !== undefined) next.tzOffset = patch.tz_offset
    set(next)
    try {
      await api.setPrefs(patch)
    } catch (e) {
      set({
        notifyDm: prev.notifyDm,
        notifyMention: prev.notifyMention,
        notifyReply: prev.notifyReply,
        notifyTask: prev.notifyTask,
        notifyPoll: prev.notifyPoll,
        dndScheduled: prev.dndScheduled,
        dndStart: prev.dndStart,
        dndEnd: prev.dndEnd,
        tzOffset: prev.tzOffset,
      })
      if (e instanceof Error) toastError(e.message)
    }
  },

  async toggleMute(channelId) {
    const muted = new Set(get().mutedChannels)
    const nextMuted = !muted.has(channelId)
    await get().setChannelMode(channelId, nextMuted ? 'muted' : 'all')
    // Preserve the historical return semantics: reflect the toggle in the set.
    void muted
  },

  async setChannelMode(channelId, mode) {
    const prevModes = get().channelModes
    const prevMuted = get().mutedChannels
    const nextModes = { ...prevModes, [channelId]: mode }
    const nextMuted = new Set(prevMuted)
    if (mode === 'muted') nextMuted.add(channelId)
    else nextMuted.delete(channelId)
    set({ channelModes: nextModes, mutedChannels: nextMuted })
    try {
      await api.setChannelMode(channelId, mode)
    } catch (e) {
      set({ channelModes: prevModes, mutedChannels: prevMuted })
      if (e instanceof Error) toastError(e.message)
    }
  },

  async enableDesktopNotifications() {
    const notificationState = await enableNotifications()
    const enabled = notificationState === 'subscribed'
    set({ notificationState, notifyEnabled: enabled })
    if (!enabled && notificationState !== 'install-required') {
      toastError('Notification permission was not granted.')
    }
  },

  async disableDesktopNotifications() {
    const notificationState = await disablePush()
    set({ notificationState, notifyEnabled: false })
  },

  applyWsEvent(env) {
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
              [p.participant.conn_id]: {
                user_id: p.participant.user_id,
                display_name: p.participant.display_name,
                annotation_color: p.participant.annotation_color,
                guest: p.participant.guest,
                muted: p.participant.muted,
                transcribing: p.participant.transcribing,
                camera_on: p.participant.camera_on,
                screen_on: p.participant.screen_on,
                  screen_stream_id: p.participant.screen_stream_id,
                  hand_raised: p.participant.hand_raised,
                  hand_raised_at: p.participant.hand_raised_at,
                  joined_at: p.participant.joined_at,
              },
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
                [p.participant.conn_id]: {
                  user_id: p.participant.user_id,
                  display_name: p.participant.display_name,
                  annotation_color: p.participant.annotation_color,
                  guest: p.participant.guest,
                  muted: p.participant.muted,
                  transcribing: p.participant.transcribing,
                  camera_on: p.participant.camera_on,
                  screen_on: p.participant.screen_on,
                screen_stream_id: p.participant.screen_stream_id,
                hand_raised: p.participant.hand_raised,
                hand_raised_at: p.participant.hand_raised_at,
                joined_at: p.participant.joined_at,
                },
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
  },
}))

// --- calendar helpers ---

function nativeItemFromMeeting(meeting: ScheduledMeeting): CalendarItem {
  return {
    source: 'native',
    id: meeting.id,
    title: meeting.title,
    start_at: meeting.start_at,
    end_at: meeting.end_at,
    all_day: meeting.all_day,
    join_path: meeting.join_path,
    meeting,
  }
}

function inCalendarRange(
  range: { from: string; to: string } | null,
  iso: string,
): boolean {
  if (!range) return false
  return iso >= range.from && iso < range.to
}

/** Insert/replace a native meeting in the item list, honoring the loaded range. */
function upsertMeetingItem(
  items: CalendarItem[],
  range: { from: string; to: string } | null,
  meeting: ScheduledMeeting,
): CalendarItem[] {
  const filtered = items.filter(
    (i) => !(i.source === 'native' && i.meeting.id === meeting.id),
  )
  if (meeting.status === 'cancelled') return filtered
  if (!inCalendarRange(range, meeting.start_at)) return filtered
  return [...filtered, nativeItemFromMeeting(meeting)]
}

function applyMyRsvp(
  meeting: ScheduledMeeting,
  myUserId: string | null,
  response: string,
): ScheduledMeeting {
  return {
    ...meeting,
    my_response: response,
    attendees: meeting.attendees.map((a) =>
      a.user_id === myUserId ? { ...a, response } : a,
    ),
  }
}

// --- voice helpers ---

function voiceRoomFromParticipants(
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
      joined_at: participant.joined_at,
    }
  }
  return room
}

function activeMeetingsFromSnapshots(snapshots: VoiceRoomSnapshot[]): Record<string, string> {
  const meetings: Record<string, string> = {}
  for (const snapshot of snapshots) {
    if (snapshot.active_meeting_id) meetings[snapshot.channel_id] = snapshot.active_meeting_id
  }
  return meetings
}

function voiceRoomsFromSnapshots(snapshots: VoiceRoomSnapshot[]): Record<string, VoiceRoom> {
  const rooms: Record<string, VoiceRoom> = {}
  for (const snapshot of snapshots) {
    rooms[snapshot.channel_id] = voiceRoomFromParticipants(snapshot.participants)
  }
  return rooms
}

function withPollVotes(
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

function voiceErrorMessage(code: string): string {
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

// --- channel helpers ---

/** Remove a channel and all its cached state; navigate home if it was open. */
function dropChannel(set: Setter, get: () => State, id: string) {
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

// --- doc helpers ---

function sortDocs(docs: Doc[]): Doc[] {
  return [...docs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
}

function countUnread(mentions: DocMention[]): number {
  return mentions.reduce((n, m) => n + (m.read_at ? 0 : 1), 0)
}

type DocSlice = {
  docsByChannel: Record<string, Doc[]>
  trashByChannel: Record<string, Doc[]>
  docMeta: Record<string, Doc>
}

function withoutDoc(map: Record<string, Doc[]>, channelId: string, id: string): Record<string, Doc[]> {
  const list = map[channelId]
  if (!list) return map
  const next = list.filter((d) => d.id !== id)
  return next.length === list.length ? map : { ...map, [channelId]: next }
}

/** Upsert a doc into the right bucket (active/trash) based on my_role + deleted_at. */
function placeDoc(s: DocSlice, doc: Doc): DocSlice {
  const cid = doc.channel_id
  if (doc.my_role === 'none') return removeDoc(s, doc.id, cid)

  const docMeta = { ...s.docMeta, [doc.id]: doc }
  let docsByChannel = withoutDoc(s.docsByChannel, cid, doc.id)
  let trashByChannel = withoutDoc(s.trashByChannel, cid, doc.id)

  if (doc.deleted_at) {
    // Only track trash for channels whose trash was explicitly loaded.
    if (trashByChannel[cid]) {
      trashByChannel = { ...trashByChannel, [cid]: sortDocs([...trashByChannel[cid], doc]) }
    }
  } else {
    const cur = docsByChannel[cid] ?? []
    docsByChannel = { ...docsByChannel, [cid]: sortDocs([...cur, doc]) }
  }
  return { docMeta, docsByChannel, trashByChannel }
}

function removeDoc(s: DocSlice, id: string, channelId?: string): DocSlice {
  const cid = channelId ?? s.docMeta[id]?.channel_id
  const docMeta = { ...s.docMeta }
  delete docMeta[id]
  if (!cid) return { ...s, docMeta }
  return {
    docMeta,
    docsByChannel: withoutDoc(s.docsByChannel, cid, id),
    trashByChannel: withoutDoc(s.trashByChannel, cid, id),
  }
}

function applyDocDeleted(s: DocSlice, p: DocDeletedPayload): DocSlice {
  if (p.permanent) return removeDoc(s, p.doc_id, p.channel_id)
  const existing =
    s.docMeta[p.doc_id] ?? s.docsByChannel[p.channel_id]?.find((d) => d.id === p.doc_id)
  if (!existing) {
    // Nothing cached: just drop from the active list if present.
    return { ...s, docsByChannel: withoutDoc(s.docsByChannel, p.channel_id, p.doc_id) }
  }
  return placeDoc(s, { ...existing, deleted_at: existing.deleted_at ?? new Date().toISOString() })
}

// --- pure helpers ---

type Setter = (
  partial:
    | Partial<State>
    | ((s: State) => Partial<State> | State),
) => void

function updateReactions(
  reactions: Message['reactions'],
  emoji: string,
  add: boolean,
  isMe: boolean,
): Message['reactions'] {
  const idx = reactions.findIndex((r) => r.emoji === emoji)
  if (add) {
    if (idx === -1) return [...reactions, { emoji, count: 1, me: isMe }]
    const r = reactions[idx]
    if (isMe && r.me) return reactions
    const next = [...reactions]
    next[idx] = { ...r, count: r.count + 1, me: r.me || isMe }
    return next
  } else {
    if (idx === -1) return reactions
    const r = reactions[idx]
    if (isMe && !r.me) return reactions
    const count = r.count - 1
    if (count <= 0) return reactions.filter((_, i) => i !== idx)
    const next = [...reactions]
    next[idx] = { ...r, count, me: isMe ? false : r.me }
    return next
  }
}

function upsertAscending(list: Message[], msg: Message): Message[] {
  if (list.some((m) => m.id === msg.id)) {
    return list.map((m) =>
      m.id === msg.id && m.content === msg.content && m.decryptedText !== undefined
        ? { ...msg, decryptedText: m.decryptedText, attachments: m.attachments }
        : m.id === msg.id
          ? msg
          : m,
    )
  }
  if (list.length === 0 || cmpId(msg.id, list[list.length - 1].id) > 0) {
    return [...list, msg]
  }
  const next = [...list, msg]
  next.sort((a, b) => cmpId(a.id, b.id))
  return next
}

function findMessage(state: State, messageId: string): Message | null {
  for (const channel of Object.values(state.byChannel)) {
    const message = channel.list.find((item) => item.id === messageId)
    if (message) return message
  }
  if (state.thread.parent?.id === messageId) return state.thread.parent
  return state.thread.replies.find((item) => item.id === messageId) ?? null
}

async function decryptIncoming(message: Message): Promise<Message> {
  if (!message.encrypted || message.deleted_at) return message
  try {
    const body = await decryptDmMessage(message)
    void indexDecryptedMessage({
      id: message.id,
      channelId: message.channel_id,
      text: body.text,
      authorName: message.user.display_name,
      ts: message.created_at,
    })
    return {
      ...message,
      decryptedText: body.text,
      attachments: resolveEncryptedAttachments(message.attachments, body.attachments),
    }
  } catch {
    return { ...message, decryptedText: null }
  }
}

function patchDecryptedMessages(set: Setter, decrypted: Message[]): void {
  const byId = new Map(decrypted.map((message) => [message.id, message]))
  const transform = (message: Message): Message => {
    const next = byId.get(message.id)
    return next && message.content === next.content
      ? { ...message, decryptedText: next.decryptedText, attachments: next.attachments }
      : message
  }
  set((state) => {
    const byChannel: Record<string, ChannelMessages> = {}
    for (const [channelId, messages] of Object.entries(state.byChannel)) {
      byChannel[channelId] = { ...messages, list: messages.list.map(transform) }
    }
    const replyTargets = { ...state.replyTargets }
    for (const [channelId, message] of Object.entries(replyTargets)) {
      replyTargets[channelId] = transform(message)
    }
    return {
      byChannel,
      replyTargets,
      thread: {
        ...state.thread,
        parent: state.thread.parent ? transform(state.thread.parent) : null,
        replies: state.thread.replies.map(transform),
      },
    }
  })
}

function queueDecryptions(set: Setter, messages: Message[]): void {
  const pending = messages.filter(
    (message) => message.encrypted && !message.deleted_at && message.decryptedText === undefined,
  )
  if (!pending.length) return
  void Promise.all(pending.map(decryptIncoming)).then((decrypted) =>
    patchDecryptedMessages(set, decrypted),
  )
}

function applyDuckStreak(
  set: Setter,
  channelId: string,
  streak: { count: number; last_at: string } | undefined,
) {
  if (!streak) {
    set((s) => ({
      duckActivity: {
        ...s.duckActivity,
        [channelId]: { count: 0, lastAt: s.duckActivity[channelId]?.lastAt ?? 0 },
      },
    }))
    return
  }
  const lastAt = Date.parse(streak.last_at)
  set((s) => ({
    duckActivity: {
      ...s.duckActivity,
      [channelId]: {
        count: streak.count,
        lastAt: Number.isFinite(lastAt) ? lastAt : Date.now(),
      },
    },
  }))
}

function applyMessageCreated(
  set: Setter,
  message: Message,
  myId: string | null,
  duckStreak?: { count: number; last_at: string },
) {
  if (message.parent_id) {
    set((s) => {
      const cm = s.byChannel[message.channel_id]
      let byChannel = s.byChannel
      if (cm) {
        const list = cm.list.map((m) =>
          m.id === message.parent_id
            ? { ...m, reply_count: m.reply_count + 1, last_reply_at: message.created_at }
            : m,
        )
        byChannel = { ...s.byChannel, [message.channel_id]: { ...cm, list } }
      }
      let thread = s.thread
      if (s.thread.open && s.thread.parentId === message.parent_id) {
        if (!s.thread.replies.some((r) => r.id === message.id)) {
          const parent = s.thread.parent
            ? {
                ...s.thread.parent,
                reply_count: s.thread.parent.reply_count + 1,
                last_reply_at: message.created_at,
              }
            : s.thread.parent
          thread = { ...s.thread, parent, replies: [...s.thread.replies, message] }
        }
      }
      return { byChannel, thread }
    })
    return
  }

  set((s) => {
    const cm = s.byChannel[message.channel_id]
    let byChannel = s.byChannel
    if (cm?.loaded) {
      byChannel = {
        ...s.byChannel,
        [message.channel_id]: { ...cm, list: upsertAscending(cm.list, message) },
      }
    }
    const isCurrent = s.currentChannelId === message.channel_id
    const fromMe = myId !== null && message.user.id === myId
    const channels = s.channels.map((c) => {
      if (c.id !== message.channel_id) return c
      const bumpUnread = !isCurrent && !fromMe
      return {
        ...c,
        last_message_at: message.created_at,
        unread_count: bumpUnread ? c.unread_count + 1 : c.unread_count,
      }
    })
    let duckActivity = s.duckActivity
    // Shared channel streak comes from the server (`duck_streak` on message.created /
    // duck.streak). Every member's top-level messages boost it; GIF-only posts skip.
    if (!message.parent_id && duckStreak) {
      const lastAt = Date.parse(duckStreak.last_at)
      duckActivity = {
        ...s.duckActivity,
        [message.channel_id]: {
          count: duckStreak.count,
          lastAt: Number.isFinite(lastAt) ? lastAt : Date.now(),
        },
      }
    }
    return { byChannel, channels, duckActivity }
  })
}

function applyMessageUpdated(set: Setter, message: Message) {
  const transform = (m: Message): Message =>
    m.id === message.id
      ? {
          ...m,
          content: message.content,
          encrypted: message.encrypted,
          decryptedText: message.encrypted ? undefined : message.decryptedText,
          edited_at: message.edited_at,
          deleted_at: message.deleted_at,
          reactions: message.reactions,
          reply_count: message.reply_count,
          last_reply_at: message.last_reply_at,
          attachments: message.attachments,
          reply_to: message.reply_to,
        }
      : m
  set((s) => {
    const byChannel: Record<string, ChannelMessages> = {}
    for (const [cid, cm] of Object.entries(s.byChannel)) {
      byChannel[cid] = { ...cm, list: cm.list.map(transform) }
    }
    let thread = s.thread
    if (s.thread.open) {
      thread = {
        ...s.thread,
        parent: s.thread.parent ? transform(s.thread.parent) : null,
        replies: s.thread.replies.map(transform),
      }
    }
    return { byChannel, thread }
  })
}

function applyMessageDeleted(
  set: Setter,
  p: { message_id: string; channel_id: string; parent_id: string | null },
) {
  const markDeleted = (m: Message): Message =>
    m.id === p.message_id
      ? { ...m, content: '', deleted_at: new Date().toISOString() }
      : m
  set((s) => {
    const cm = s.byChannel[p.channel_id]
    let byChannel = s.byChannel
    if (cm) {
      let list: Message[]
      if (p.parent_id) {
        list = cm.list.map((m) =>
          m.id === p.parent_id ? { ...m, reply_count: Math.max(0, m.reply_count - 1) } : m,
        )
      } else {
        list = cm.list.map(markDeleted)
      }
      byChannel = { ...s.byChannel, [p.channel_id]: { ...cm, list } }
    }
    let thread = s.thread
    if (s.thread.open) {
      if (p.parent_id) {
        thread = {
          ...s.thread,
          parent:
            s.thread.parent && s.thread.parent.id === p.parent_id
              ? { ...s.thread.parent, reply_count: Math.max(0, s.thread.parent.reply_count - 1) }
              : s.thread.parent,
          replies: s.thread.replies.map(markDeleted),
        }
      } else {
        thread = { ...s.thread, parent: s.thread.parent ? markDeleted(s.thread.parent) : null }
      }
    }
    return { byChannel, thread }
  })
}

// Global typing pruner.
if (typeof window !== 'undefined') {
  setInterval(() => useStore.getState().pruneTyping(), 1000)
  window.addEventListener('beforeunload', () => {
    const { voice, ws } = useStore.getState()
    if (voice.channelId) ws?.send('voice.leave', { channel_id: voice.channelId })
  })
}
