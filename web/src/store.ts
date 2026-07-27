import { create } from 'zustand'
import {
  api,
  ApiRequestError,
  clearToken,
  getToken,
  setSessionToken,
  setToken,
} from './lib/api'
import { applyUiPrefs } from './lib/theme'
import { configureCelebrations } from './lib/celebrate'
import { normalizeWallpaper, type Wallpaper } from './lib/wallpaper'
import { setShortcutOverrides } from './lib/shortcuts'
import {
  normalizeUiPrefs,
  readLocalUiPrefs,
  writeLocalUiPrefs,
  type RailPosition,
  type UiPrefs,
} from './lib/uiPrefs'
import { packPreview, setPackPreview } from './lib/seasonal'
import type { VoiceClient } from './lib/voice'
import { annotations } from './lib/annotations'
import { allowLocalReaction, callReactions, rememberReaction } from './lib/callReactions'
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
import { getAudioAuraStyle, setAudioAuraStyle, type AudioAuraStyle } from './lib/meetingEffects'
import { WsClient } from './lib/ws'
import {
  currentVoiceRecognizer,
  setVoiceRecognizer,
  stopVoiceRecognizer,
} from './lib/store/recognizer'
import { KEYS, readLocal, readLocalBool, writeLocal, writeLocalBool } from './lib/localPrefs'
import { applyWsEventTo } from './lib/wsEvents'
import { sortTasks } from './lib/store/taskHelpers'
import { applyUi } from './lib/store/uiHelpers'
import {
  emptyVoiceState,
  saveNoiseSuppression,
  saveVoicePushToTalk,
  saveVoiceSpatial,
} from './lib/store/voiceHelpers'

// The pure state predicates live in lib/store/predicates.ts; every caller imports them
// from here, so they stay re-exported.
export {
  dndActive,
  streamChannelShielded,
  streamShieldOn,
  streamingActive,
  streamShieldsChannel,
} from './lib/store/predicates'
import {
  streamingActive,
} from './lib/store/predicates'
import {
  applyMyRsvp,
  upsertMeetingItem,
} from './lib/store/calendarHelpers'
import { dropChannel } from './lib/store/channelHelpers'
import {
  countUnread,
  placeDoc,
  removeDoc,
  sortDocs,
} from './lib/store/docHelpers'
import {
  findMessage,
  queueDecryptions,
  updateReactions,
} from './lib/store/messageHelpers'
import {
  withPollVotes,
} from './lib/store/voiceHelpers'
import {
  encryptDmMessage,
  ensureDevice,
  getDevices,
  getLocalDevice,
  invalidateDevices,
  isChannelEncrypted,
} from './lib/e2ee'
import { idbClear } from './lib/e2ee/idb'
import { restoreBackup } from './lib/e2ee/backup'
import { toastError } from './lib/toast'
import { navigateTo } from './lib/nav'
import {
  disablePush,
  enableNotifications,
  getNotificationState,
  initPush,
  initialNotificationState,
  type NotificationSetupState,
} from './lib/notify'
import {
  setSoundPack,
  setSoundSink,
  playVoiceJoinSound,
  playVoiceLeaveSound,
  sound,
} from './lib/sound'
import type {
  Channel,
  ChannelMember,
  ChannelNotifyMode,
  PushPreview,
  PrefsUpdate,
  ChannelRole,
  ChatLayout,
  Doc,
  DocMention,
  GifConfig,
  GardenMap,
  GardenPeer,
  Message,
  EncryptedAttachment,
  Notification,
  User,
  VoiceStatePayload,
  VoiceTrigger,
  CalendarConnection,
  CalendarItem,
  ScheduledMeeting,
  Poll,
  CallPoll,
  Project,
  Task,
  TaskDetail,
  TaskLabel,
  TaskUpdateInput,
  SharpyConversation,
  SharpyMessage,
  SharpySource,
  WsEnvelope,
} from './lib/types'

const PAGE = 50
/** Messages retained per channel once you navigate away. Four pages. */
const MAX_CACHED_MESSAGES = 200


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
    aura_style: string | null
    garden_active: boolean
    pos_x: number
    pos_y: number
    joined_at: string
  }
>

export type VoiceStageMode = 'expanded' | 'compact' | 'mini' | 'full'
// Owned by lib/uiPrefs.ts now that it is part of the synced appearance blob;
// re-exported so the existing `import type { RailPosition } from '../store'`
// call sites keep working.
export type { RailPosition } from './lib/uiPrefs'

export type VoiceState = {
  channelId: string | null
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting'
  muted: boolean
  // Push to talk: the mic stays closed and Space opens it. The mode is device-local
  // (see storedVoicePushToTalk); `pushToTalkHeld` is the live hold, never persisted.
  pushToTalk: boolean
  pushToTalkHeld: boolean
  // People this device has silenced for itself ("Mute for me"). Keyed by user id, so a
  // person is muted across all their connections, and dropped on leave — "I can't hear
  // Ana" is a choice about this call, not a setting.
  locallyMutedUsers: Set<string>
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
  // Spatial view: floor plan instead of the grid, and remote audio panned by where
  // people stand. Device-local (see storedVoiceSpatial) — your positions are shared,
  // your way of listening to them is not.
  spatial: boolean
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

export type GardenAudioMode = 'ask' | 'on' | 'off'

export type GardenClientState = {
  active: boolean
  status: 'idle' | 'loading' | 'connected' | 'error'
  map: GardenMap | null
  self: GardenPeer | null
  peers: Record<string, GardenPeer>
  space: 'hub' | 'room'
  channelId: string | null
  audioMode: GardenAudioMode
  managedVoiceChannelId: string | null
  error: string | null
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
export type State = {
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

  // doc/canvas/board inline "peek" panel (chat mode)
  docPeekId: string | null

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
  // Server-enforced privacy switches (migration 0031).
  invisible: boolean
  shareTyping: boolean
  pushPreview: PushPreview
  dndScheduled: boolean
  dndStart: number | null
  dndEnd: number | null
  tzOffset: number
  notifyEnabled: boolean
  notificationState: NotificationSetupState
  notifHasMore: boolean

  // chat layout preference: null until the user has chosen (triggers first-run chooser)
  chatLayout: ChatLayout | null

  // The synced appearance blob (theme, scheme, accent, density, scale, motion,
  // rail, sounds). Server-backed via PATCH /prefs/ui; see lib/uiPrefs.ts.
  ui: UiPrefs
  /** Seasonal pack pinned for preview ("Try it now"), overriding the calendar.
   *  Device-local; the value lives in lib/seasonal.ts, this mirrors it so the
   *  components that render a pack re-render when it changes. */
  seasonPreview: string | null
  /** Per-channel chat wallpapers, from `channel_prefs.wallpaper`. */
  channelWallpapers: Record<string, Wallpaper>
  // Desktop navigation preference. Mirrors `ui.railPosition` so the many
  // existing readers do not have to reach into the blob.
  railPosition: RailPosition
  // Bottom dock only: slide away until the cursor nears the bottom edge.
  // Mirrors `ui.dockAutoHide`.
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
  garden: GardenClientState

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
  /** Warm a channel's message cache before the user commits to opening it. */
  prefetchChannel: (channelId: string) => void
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
    input: {
      name?: string
      topic?: string
      kind?: 'public' | 'private'
      ai_excluded?: boolean
      message_ttl_minutes?: number | null
    },
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

  openDocPeek: (id: string) => void
  closeDocPeek: () => void

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
    opts?: { stageMode?: VoiceStageMode; linkToken?: string; gardenActive?: boolean },
  ) => Promise<void>
  connectVoiceMedia: (payload: VoiceStatePayload) => Promise<void>
  leaveVoice: () => void
  toggleVoiceMute: () => void
  /** The one writer of `voice.muted`: mic button, M, push-to-talk, and the server echo. */
  setVoiceMuted: (muted: boolean, opts?: { silent?: boolean; fromServer?: boolean }) => void
  setPushToTalk: (enabled: boolean) => void
  setPushToTalkHeld: (held: boolean) => void
  /** Silence one person for this device only. Sends nothing to the room. */
  togglePeerLocalMute: (userId: string) => void
  /** Mute someone else's mic for the whole room (`voice.force_mute`). */
  forceMuteParticipant: (connId: string) => void
  toggleNoiseSuppression: () => Promise<void>
  setVoiceVideoBackground: (background: VideoBackground) => Promise<void>
  toggleVoiceHand: () => void
  setVoiceAuraStyle: (style: AudioAuraStyle) => void
  toggleTranscription: () => void
  toggleVoiceCamera: () => void
  toggleVoiceScreen: () => Promise<void>
  setVoiceAudioDevice: (deviceId: string) => Promise<void>
  setVoiceVideoDevice: (deviceId: string) => Promise<void>
  setVoiceStageMode: (mode: VoiceStageMode) => void
  setVoiceSpatial: (enabled: boolean) => void
  moveVoiceSelf: (x: number, y: number) => void
  moveVoiceParticipant: (connId: string, x: number, y: number) => void
  toggleAnnotating: () => void
  setAnnotationsAllowed: (allowed: boolean) => void
  clearAnnotations: () => void
  sendVoiceReaction: (emoji: string) => void

  // Garden actions
  loadGarden: () => Promise<void>
  enterGarden: () => Promise<void>
  leaveGarden: () => void
  moveGarden: (
    seq: number,
    x: number,
    y: number,
    facing: GardenPeer['facing'],
  ) => void
  enterGardenRoom: (channelId: string) => Promise<void>
  teleportGardenRoom: (channelId: string) => Promise<void>
  teleportGardenTemple: () => void
  exitGardenRoom: () => void
  setGardenZen: (enabled: boolean) => void
  setGardenAudio: (mode: Exclude<GardenAudioMode, 'ask'>) => void

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
  deleteScheduledMeeting: (id: string) => Promise<void>
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
  /** Merge an appearance patch: apply locally, mirror, sync, roll back on failure. */
  patchUi: (patch: Partial<UiPrefs>) => void
  /** Pin a seasonal pack regardless of the date, or `null` to follow the calendar. */
  setSeasonPreview: (packId: string | null) => void
  setChannelWallpaper: (channelId: string, wallpaper: Wallpaper) => Promise<void>
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

function emptyChannelMessages(): ChannelMessages {
  return { list: [], loaded: false, loading: false, hasMore: true }
}



/** Local mirror of the appearance blob, replaced by the server copy on login. */
// Spatial moves are produced at pointer/animation rate but only need to travel often
// enough to sound continuous. Send at most every MOVE_SEND_MS per moved participant,
// always with a trailing send so the final resting position is the one everyone else
// ends up with. Keyed by conn id because you can drag other people too.
const MOVE_SEND_MS = 70
const moveThrottles = new Map<
  string,
  { lastSentAt: number; timer: ReturnType<typeof setTimeout> | null }
>()

const initialUi = readLocalUiPrefs()
// Sounds can fire before the first `applyUi` (splash, login), so seed the pack
// from the mirror at module load rather than waiting for hydration.
setSoundPack(initialUi.soundPack)
setShortcutOverrides(initialUi.shortcuts)
configureCelebrations({
  enabled: initialUi.celebrations && !initialUi.focusMode,
  motion: initialUi.motion,
})

/**
 * Push a resolved appearance blob everywhere it is consumed: store state, the
 * two mirrored fields, the DOM (theme attribute + runtime vars), and the sound
 * engine. Persistence is the caller's job — hydration must not write back.
 */

function storedStreamManual(): boolean {
  try {
    return readLocalBool(KEYS.streamManual, false)
  } catch {
    return false
  }
}

function storedStreamRevertNicknames(): boolean {
  try {
    return readLocalBool(KEYS.streamRevertNicknames, false)
  } catch {
    return false
  }
}

function storedGardenAudio(): GardenAudioMode {
  const value = readLocal(KEYS.gardenAudio)
  return value === 'on' || value === 'off' ? value : 'ask'
}

function emptyGardenState(audioMode = storedGardenAudio()): GardenClientState {
  return {
    active: false,
    status: 'idle',
    map: null,
    self: null,
    peers: {},
    space: 'hub',
    channelId: null,
    audioMode,
    managedVoiceChannelId: null,
    error: null,
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
  docPeekId: null,
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
  invisible: false,
  shareTyping: true,
  pushPreview: 'full',
  notifyEnabled: false,
  notificationState: initialNotificationState(),
  notifHasMore: false,
  chatLayout: null,
  ui: initialUi,
  seasonPreview: packPreview(),
  channelWallpapers: {},
  railPosition: initialUi.railPosition,
  dockAutoHide: initialUi.dockAutoHide,
  streamManual: storedStreamManual(),
  streamRevealAllUntil: null,
  streamRevealChannels: {},
  streamRevertNicknames: storedStreamRevertNicknames(),
  voiceRooms: {},
  activeMeetings: {},
  voice: emptyVoiceState(),
  garden: emptyGardenState(),
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
        if (get().garden.active) {
          void get().loadGarden()
          get().ws?.send('garden.enter', {})
        }
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
    get().leaveGarden()
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
      docPeekId: null,
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
      garden: emptyGardenState(),
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
      // Bound the cache: a channel you scrolled a long way back through keeps
      // every page in memory forever otherwise. Trim on the way *out*, never
      // while it is on screen — dropping rows under a live scroll position
      // would jump the viewport. `hasMore` goes back to true so scrolling up
      // re-fetches what was dropped.
      const leaving = s.currentChannelId
      const cached = leaving ? s.byChannel[leaving] : undefined
      const byChannel =
        cached && cached.list.length > MAX_CACHED_MESSAGES
          ? {
              ...s.byChannel,
              [leaving as string]: {
                ...cached,
                list: cached.list.slice(-MAX_CACHED_MESSAGES),
                hasMore: true,
              },
            }
          : s.byChannel
      return {
        currentChannelId: id,
        paletteForMessageId: null,
        activeMessageId: null,
        byChannel,
      }
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

  prefetchChannel(channelId) {
    // The store already caches per channel and never refetches once loaded, so
    // a prefetch is just an early `loadMessages` — the click that follows finds
    // the cache warm and renders with no spinner.
    const cm = get().byChannel[channelId]
    if (cm?.loaded || cm?.loading) return
    void get().loadMessages(channelId)
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
    // Right-side panels are mutually exclusive.
    set({ thread: { open: true, parentId, parent: null, replies: [], loading: true }, docPeekId: null })
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

  openDocPeek(id) {
    // The peek covers the main column, so open side panels go with it.
    set({
      docPeekId: id,
      thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
      sharpyOpen: false,
    })
    // Warm the meta cache so the panel can render its header immediately.
    void get().fetchDoc(id).catch(() => {})
  },

  closeDocPeek() {
    set({ docPeekId: null })
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
    // Opening Sharpy closes the doc peek (mutually exclusive right-side panels).
    set(open ? { sharpyOpen: true, docPeekId: null } : { sharpyOpen: false })
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

  async loadGarden() {
    set((s) => ({ garden: { ...s.garden, status: 'loading', error: null } }))
    try {
      const map = await api.gardenMap()
      set((s) => ({
        garden: {
          ...s.garden,
          map,
          status: s.garden.active ? 'connected' : 'idle',
          error: null,
        },
      }))
    } catch (error) {
      set((s) => ({
        garden: {
          ...s.garden,
          status: 'error',
          error: error instanceof Error ? error.message : 'Could not load Garden.',
        },
      }))
    }
  },

  async enterGarden() {
    set((s) => ({
      garden: { ...s.garden, active: true, status: 'loading', error: null },
    }))
    await get().loadGarden()
    get().ws?.send('garden.enter', {})
  },

  leaveGarden() {
    const garden = get().garden
    get().ws?.send('garden.leave', {})
    if (
      garden.managedVoiceChannelId &&
      get().voice.channelId === garden.managedVoiceChannelId
    ) {
      get().leaveVoice()
    }
    set({ garden: emptyGardenState(garden.audioMode) })
  },

  moveGarden(seq, x, y, facing) {
    if (!get().garden.active) return
    get().ws?.send('garden.move', { seq, x, y, facing })
  },

  async enterGardenRoom(channelId) {
    const room = get().garden.map?.rooms.find((candidate) => candidate.channel_id === channelId)
    if (!room) return
    if (!room.is_member) {
      if (room.kind !== 'public') return
      await get().joinChannel(channelId)
      await get().loadGarden()
    }
    get().ws?.send('garden.room_enter', { channel_id: channelId })
  },

  async teleportGardenRoom(channelId) {
    const room = get().garden.map?.rooms.find((candidate) => candidate.channel_id === channelId)
    if (!room) return
    if (!room.is_member) {
      if (room.kind !== 'public') return
      await get().joinChannel(channelId)
      await get().loadGarden()
    }
    get().ws?.send('garden.room_teleport', { channel_id: channelId })
  },

  teleportGardenTemple() {
    get().ws?.send('garden.temple_teleport', {})
  },

  exitGardenRoom() {
    get().ws?.send('garden.room_exit', {})
  },

  setGardenZen(enabled) {
    get().ws?.send('garden.zen', { enabled })
  },

  setGardenAudio(mode) {
    writeLocal(KEYS.gardenAudio, mode)
    const current = get()
    set((s) => ({ garden: { ...s.garden, audioMode: mode, error: null } }))
    if (mode === 'off') {
      if (
        current.garden.managedVoiceChannelId &&
        current.voice.channelId === current.garden.managedVoiceChannelId
      ) {
        current.leaveVoice()
      }
      set((s) => ({
        garden: { ...s.garden, managedVoiceChannelId: null },
      }))
      return
    }
    const channelId = current.garden.channelId
    if (!channelId) return
    if (!current.voice.channelId) {
      set((s) => ({
        garden: { ...s.garden, managedVoiceChannelId: channelId },
      }))
      void current.joinVoice(channelId, { stageMode: 'mini', gardenActive: true })
    } else if (current.voice.channelId !== channelId) {
      set((s) => ({
        garden: {
          ...s.garden,
          error: 'Your current call is still active. Leave it to hear this room.',
        },
      }))
    }
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
      // The idle slice is the shape of record; only what joining actually decides is
      // overridden here (device prefs and the per-user background beat the defaults).
      voice: {
        ...emptyVoiceState(),
        channelId,
        status: 'connecting',
        videoBackground,
        stageMode: opts?.stageMode ?? 'expanded',
        audioDeviceId: devicePrefs.audioDeviceId,
        videoDeviceId: devicePrefs.videoDeviceId,
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
        aura_style: getAudioAuraStyle(get().me?.id),
        garden_active: opts?.gardenActive ?? false,
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
      // Positional audio is remembered per device; tracks subscribed later pick it
      // up on their own (handleTrackSubscribed checks the flag).
      if (active.spatial) client.setSpatialAudio(true)
      // Push to talk is remembered too, and it must hold on the way in: joining a call
      // with a hot mic is exactly what the mode exists to prevent.
      if (active.pushToTalk) get().setVoiceMuted(true, { silent: true })
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

  // The mic button and M. In push-to-talk mode there is nothing to toggle — the key
  // does that — so this leaves the mode instead, which is the only way back to an open
  // mic that does not require finding a menu.
  toggleVoiceMute() {
    const { channelId, client, muted, pushToTalk } = get().voice
    if (!channelId || !client) return
    if (pushToTalk) {
      get().setPushToTalk(false)
      return
    }
    get().setVoiceMuted(!muted)
  },

  // Every path that changes the mic goes through here: the toggle above, the
  // push-to-talk key, and the server echo when someone force-mutes you. `silent`
  // skips the click for the key, which would otherwise chirp on every syllable.
  setVoiceMuted(muted, opts) {
    const { channelId, client, handRaised } = get().voice
    if (!channelId || !client) return
    if (get().voice.muted === muted) return
    client.setMuted(muted)
    if (!opts?.silent) {
      if (muted) sound.micMute()
      else sound.micUnmute()
    }
    // Unmuting optimistically lowers a raised hand; the server confirms via the
    // participant_updated echo it broadcasts for the mute change.
    const lowerHand = !muted && handRaised
    set((s) => ({
      voice: {
        ...s.voice,
        muted,
        handRaised: lowerHand ? false : s.voice.handRaised,
        // A mute that came from the room (someone force-muted you) ends the hold, so
        // releasing the key later cannot re-open a mic you were asked to close.
        pushToTalkHeld: muted ? false : s.voice.pushToTalkHeld,
      },
    }))
    if (get().voice.transcribing) {
      if (muted) currentVoiceRecognizer()?.pause()
      else currentVoiceRecognizer()?.resume()
    }
    // The server already knows when it is the one that told us.
    if (!opts?.fromServer) get().ws?.send('voice.mute', { channel_id: channelId, muted })
  },

  // Turning push-to-talk on closes the mic immediately: the promise of the mode is
  // that nothing goes out unless a key is down.
  setPushToTalk(enabled) {
    saveVoicePushToTalk(enabled)
    set((s) => ({ voice: { ...s.voice, pushToTalk: enabled, pushToTalkHeld: false } }))
    get().setVoiceMuted(enabled)
  },

  setPushToTalkHeld(held) {
    if (!get().voice.pushToTalk || get().voice.pushToTalkHeld === held) return
    set((s) => ({ voice: { ...s.voice, pushToTalkHeld: held } }))
    get().setVoiceMuted(!held, { silent: true })
  },

  // Local only, and deliberately not persisted: silencing someone is about this call.
  // Applied to every connection they have, so a second device is not a way around it.
  togglePeerLocalMute(userId) {
    const { channelId, client } = get().voice
    if (!channelId || !client) return
    const next = new Set(get().voice.locallyMutedUsers)
    const muted = !next.has(userId)
    if (muted) next.add(userId)
    else next.delete(userId)
    for (const [connId, entry] of Object.entries(get().voiceRooms[channelId] ?? {})) {
      if (entry.user_id === userId) client.setPeerLocalMuted(connId, muted)
    }
    set((s) => ({ voice: { ...s.voice, locallyMutedUsers: next } }))
  },

  // Room-wide, and server-authoritative: the mute lands when the echoed roster says
  // so, exactly like a self-mute. Muting only — nobody can force a mic open.
  forceMuteParticipant(connId) {
    const { channelId, status } = get().voice
    if (!channelId || status !== 'connected') return
    get().ws?.send('voice.force_mute', { channel_id: channelId, conn_id: connId })
  },

  // Purely local mic denoising — no WS event; peers only hear the cleaned track.
  async toggleNoiseSuppression() {
    const next = !get().voice.noiseSuppression
    saveNoiseSuppression(next)
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

  setVoiceAuraStyle(style) {
    const me = get().me
    if (me) setAudioAuraStyle(me.id, style)
    // Broadcast the pick so every participant sees this signature on our avatar.
    const { channelId, status } = get().voice
    if (channelId && status === 'connected') {
      get().ws?.send('voice.aura', { channel_id: channelId, aura_style: style })
    }
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
        if (currentVoiceRecognizer() !== recognizer) return
        setVoiceRecognizer(null)
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
    setVoiceRecognizer(recognizer)
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

  setVoiceSpatial(enabled) {
    saveVoiceSpatial(enabled)
    set((s) => ({ voice: { ...s.voice, spatial: enabled } }))
    get().voice.client?.setSpatialAudio(enabled)
  },

  moveVoiceSelf(x, y) {
    const myConnId = get().myConnId
    if (myConnId) get().moveVoiceParticipant(myConnId, x, y)
  },

  // Optimistic on purpose, unlike the rest of the voice slice: a dragged avatar must
  // track the pointer with no round trip. The server clamps and echoes the same value
  // back through voice.participant_moved, so a rejected move self-corrects. Anyone in
  // the room may move anyone — the floor is shared furniture.
  moveVoiceParticipant(connId, x, y) {
    const { voice, ws } = get()
    const channelId = voice.channelId
    if (!channelId || voice.status !== 'connected') return
    const clamped = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
    set((s) => {
      const room = s.voiceRooms[channelId]
      const entry = room?.[connId]
      if (!entry) return {}
      return {
        voiceRooms: {
          ...s.voiceRooms,
          [channelId]: { ...room, [connId]: { ...entry, pos_x: clamped.x, pos_y: clamped.y } },
        },
      }
    })
    if (!ws) return

    const throttle = moveThrottles.get(connId) ?? { lastSentAt: 0, timer: null }
    moveThrottles.set(connId, throttle)
    const send = () => {
      throttle.lastSentAt = Date.now()
      throttle.timer = null
      const latest = get()
      const position = latest.voiceRooms[channelId]?.[connId]
      if (!position || latest.voice.channelId !== channelId) return
      latest.ws?.send('voice.move', {
        channel_id: channelId,
        conn_id: connId,
        x: position.pos_x,
        y: position.pos_y,
      })
    }
    const elapsed = Date.now() - throttle.lastSentAt
    if (elapsed >= MOVE_SEND_MS) {
      if (throttle.timer) clearTimeout(throttle.timer)
      send()
    } else if (!throttle.timer) {
      throttle.timer = setTimeout(send, MOVE_SEND_MS - elapsed)
    }
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

  sendVoiceReaction(emoji) {
    const { channelId } = get().voice
    const { myConnId, me, ws } = get()
    if (!channelId || !myConnId) return
    // Mirrors the server's per-connection window, so a reaction the server would
    // drop is never echoed locally as if it had landed.
    if (!allowLocalReaction()) return
    rememberReaction(emoji)
    // Shown immediately; the relay of our own event is ignored in wsEvents.
    // Guests have no `me`, so their identity comes from the room roster.
    const mine = get().voiceRooms[channelId]?.[myConnId]
    callReactions.push({
      channelId,
      connId: myConnId,
      userId: me?.id ?? mine?.user_id ?? myConnId,
      name: me?.display_name ?? mine?.display_name ?? 'You',
      emoji,
    })
    ws?.send('voice.react', { channel_id: channelId, emoji })
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

  async deleteScheduledMeeting(id) {
    await api.calendar.meetings.delete(id)
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
        invisible: prefs.invisible ?? false,
        shareTyping: prefs.share_typing ?? true,
        pushPreview: prefs.push_preview ?? 'full',
        chatLayout: prefs.chat_layout,
        nicknames: nickRes.nicknames ?? {},
        channelWallpapers: Object.fromEntries(
          Object.entries(prefs.channel_wallpapers ?? {}).map(([id, raw]) => [
            id,
            normalizeWallpaper(raw),
          ]),
        ),
      })
      // The server blob wins over the local mirror outright — no merge, no
      // clock comparison. Missing fields fall back to what this device had, so
      // a first login on a fresh account keeps the theme chosen at signup.
      const local = get().ui
      const merged = normalizeUiPrefs(prefs.ui, local)
      applyUi(set, merged)
      writeLocalUiPrefs(merged)
      // Nothing stored server-side yet (fresh account, or an upgrade from the
      // pre-0029 localStorage-only keys): adopt what this device has so the
      // choice actually follows the user. Signup picks a theme before a token
      // exists, so this is the only place that write can happen.
      if (!prefs.ui || Object.keys(prefs.ui).length === 0) {
        void api.patchUiPrefs(merged).catch(() => {
          // Best-effort — the local mirror already holds the value.
        })
      }
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

  patchUi(patch) {
    const prev = get().ui
    const next = normalizeUiPrefs({ ...prev, ...patch }, prev)
    applyUi(set, next)
    // The mirror is what the boot script reads, so write it before the network.
    writeLocalUiPrefs(next)
    // Anonymous surfaces (the login theme picker) have no row to patch yet;
    // the mirror is enough and gets flushed once the session exists.
    if (!getToken()) return
    void api.patchUiPrefs(patch).catch((e) => {
      applyUi(set, prev)
      writeLocalUiPrefs(prev)
      if (e instanceof Error) toastError(e.message)
    })
  },

  setSeasonPreview(packId) {
    setPackPreview(packId)
    set({ seasonPreview: packPreview() })
    // The accent retint and `data-season` come out of applyUiPrefs, which reads
    // the pack itself — re-run it with the unchanged prefs, keeping the
    // streaming shield's borrowed focus mode intact.
    applyUiPrefs(get().ui, streamingActive(get()))
  },

  async setChannelWallpaper(channelId, wallpaper) {
    const prev = get().channelWallpapers
    const next = { ...prev }
    if (wallpaper.kind === 'none') delete next[channelId]
    else next[channelId] = wallpaper
    set({ channelWallpapers: next })
    try {
      await api.setChannelWallpaper(
        channelId,
        wallpaper.kind === 'none' ? null : wallpaper,
      )
    } catch (e) {
      set({ channelWallpapers: prev })
      if (e instanceof Error) toastError(e.message)
    }
  },

  setRailPosition(position) {
    get().patchUi({ railPosition: position })
  },

  setDockAutoHide(autoHide) {
    get().patchUi({ dockAutoHide: autoHide })
  },

  setStreamManual(on) {
    // Turning the mode off also drops any reveal grants so re-arming starts shielded.
    set({
      streamManual: on,
      ...(on ? {} : { streamRevealAllUntil: null, streamRevealChannels: {} }),
    })
    try {
      writeLocalBool(KEYS.streamManual, on)
    } catch {
      // The preference is still usable for this session if storage is unavailable.
    }
  },

  setStreamRevertNicknames(on) {
    set({ streamRevertNicknames: on })
    try {
      writeLocalBool(KEYS.streamRevertNicknames, on)
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
    if (patch.invisible !== undefined) next.invisible = patch.invisible
    if (patch.share_typing !== undefined) next.shareTyping = patch.share_typing
    if (patch.push_preview !== undefined) next.pushPreview = patch.push_preview
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
        invisible: prev.invisible,
        shareTyping: prev.shareTyping,
        pushPreview: prev.pushPreview,
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

  // The WS event reducer lives in lib/wsEvents.ts — see the guardrail there about
  // keeping the event list in lockstep with the server.
  applyWsEvent(env) {
    applyWsEventTo(env, set, get)
  },
}))

// Sound settings are edited through the sound engine's own API (it owns the
// audio graph), but they are part of the synced appearance blob — route every
// change back through the store so it reaches the server and other devices.
setSoundSink((s) => useStore.getState().patchUi({ sounds: s }))

// Streaming implies Focus: while you are on camera or sharing a screen, the
// decorative layer is off. This borrows focus mode without writing the stored
// preference, so the user's own setting comes back when the stream ends.
let lastStreaming = streamingActive(useStore.getState())
useStore.subscribe((s) => {
  const streaming = streamingActive(s)
  if (streaming === lastStreaming) return
  lastStreaming = streaming
  applyUiPrefs(s.ui, streaming)
  configureCelebrations({
    enabled: s.ui.celebrations && !s.ui.focusMode && !streaming,
    motion: s.ui.motion,
  })
})

// Global typing pruner.
if (typeof window !== 'undefined') {
  setInterval(() => useStore.getState().pruneTyping(), 1000)
  window.addEventListener('beforeunload', () => {
    const { voice, ws } = useStore.getState()
    if (voice.channelId) ws?.send('voice.leave', { channel_id: voice.channelId })
  })
}
