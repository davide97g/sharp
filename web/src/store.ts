import { create } from 'zustand'
import { api, ApiRequestError, clearToken, setSessionToken, setToken } from './lib/api'
import { VoiceClient } from './lib/voice'
import { isSpeechSupported, PhraseRecognizer } from './lib/speech'
import { WsClient } from './lib/ws'
import { cmpId } from './lib/util'
import { gifPreviewText } from './lib/gif'
import { toastError, toastInfo, toastNotify } from './lib/toast'
import { navigateTo } from './lib/nav'
import {
  initPush,
  isWebNotifyGranted,
  navigateToChannel,
  requestNotifyPermission,
  showOsNotification,
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
  Notification,
  NotificationCreatedPayload,
  PresencePayload,
  ReactionPayload,
  TypingPayload,
  User,
  UserUpdatedPayload,
  VoiceErrorPayload,
  VoiceParticipantJoinedPayload,
  VoiceParticipantLeftPayload,
  VoiceParticipantUpdatedPayload,
  VoiceRoomSnapshot,
  VoiceSignalPayload,
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

type VoiceState = {
  channelId: string | null
  status: 'idle' | 'connecting' | 'connected'
  muted: boolean
  noiseSuppression: boolean
  noiseSuppressionAvailable: boolean
  blurEnabled: boolean
  handRaised: boolean
  transcribing: boolean
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
}

export type ChannelMessages = {
  list: Message[] // top-level, ascending
  loaded: boolean
  loading: boolean
  hasMore: boolean
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
  online: Set<string>
  myConnId: string | null

  // channels
  channels: Channel[]
  currentChannelId: string | null

  // messages keyed by channel id
  byChannel: Record<string, ChannelMessages>

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
  notifyEnabled: boolean
  notifHasMore: boolean

  // chat layout preference: null until the user has chosen (triggers first-run chooser)
  chatLayout: ChatLayout | null

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
  refreshGifConfig: () => Promise<void>
  resetDuckActivity: (channelId: string) => void

  setCurrentChannel: (id: string | null) => void
  loadMessages: (channelId: string) => Promise<void>
  loadOlder: (channelId: string) => Promise<void>
  sendMessage: (
    channelId: string,
    content: string,
    parentId?: string,
    attachmentIds?: string[],
    replyToId?: string,
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

  openThread: (parentId: string) => Promise<void>
  closeThread: () => void

  setQuickSwitcher: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setInboxOpen: (open: boolean) => void
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
  leaveVoice: () => void
  toggleVoiceMute: () => void
  toggleNoiseSuppression: () => Promise<void>
  toggleVoiceBlur: () => void
  toggleVoiceHand: () => void
  toggleTranscription: () => void
  toggleVoiceCamera: () => void
  toggleVoiceScreen: () => Promise<void>
  setVoiceAudioDevice: (deviceId: string) => Promise<void>
  setVoiceVideoDevice: (deviceId: string) => Promise<void>
  setVoiceStageMode: (mode: VoiceStageMode) => void

  // docs actions
  loadChannelDocs: (channelId: string) => Promise<void>
  loadChannelTrash: (channelId: string) => Promise<void>
  createDoc: (
    channelId: string,
    input?: { title?: string; icon?: string; kind?: 'doc' | 'canvas' },
  ) => Promise<Doc>
  createCanvas: (channelId: string, input?: { title?: string; icon?: string }) => Promise<Doc>
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

  // notifications + preferences
  loadInboxAndPrefs: () => Promise<void>
  loadMoreNotifications: () => Promise<void>
  markNotifRead: (id: string) => void
  markAllNotifRead: () => void
  markChannelNotifsRead: (channelId: string) => void
  setDnd: (dnd: boolean) => Promise<void>
  toggleMute: (channelId: string) => Promise<void>
  enableDesktopNotifications: () => Promise<void>

  // profile + chat layout
  setChatLayout: (layout: ChatLayout) => Promise<void>
  updateProfile: (input: { display_name?: string }) => Promise<void>
  uploadAvatar: (file: Blob, onProgress?: (f: number) => void) => Promise<void>
  removeAvatar: () => Promise<void>

  applyWsEvent: (env: WsEnvelope) => void
  totalUnread: () => number
}

function emptyChannelMessages(): ChannelMessages {
  return { list: [], loaded: false, loading: false, hasMore: true }
}

const NOISE_SUPPRESSION_KEY = 'sharp.noiseSuppression'

function storedNoiseSuppression(): boolean {
  try {
    return window.localStorage.getItem(NOISE_SUPPRESSION_KEY) !== '0'
  } catch {
    return true
  }
}

// Background blur is opt-in: default OFF unless the user turned it on before.
const VIDEO_BLUR_KEY = 'sharp.videoBlur'

function storedVideoBlur(): boolean {
  try {
    return window.localStorage.getItem(VIDEO_BLUR_KEY) === '1'
  } catch {
    return false
  }
}

function emptyVoiceState(): VoiceState {
  return {
    channelId: null,
    status: 'idle',
    muted: false,
    noiseSuppression: storedNoiseSuppression(),
    noiseSuppressionAvailable: true,
    blurEnabled: storedVideoBlur(),
    handRaised: false,
    transcribing: false,
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
  online: new Set(),
  myConnId: null,
  channels: [],
  currentChannelId: null,
  byChannel: {},
  gifConfig: null,
  duckActivity: {},
  members: {},
  channelVoiceTriggers: {},
  thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
  typing: {},
  quickSwitcherOpen: false,
  searchOpen: false,
  inboxOpen: false,
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
  notifyEnabled: isWebNotifyGranted(),
  notifHasMore: false,
  chatLayout: null,
  voiceRooms: {},
  activeMeetings: {},
  voice: emptyVoiceState(),
  calendarConnections: [],
  calendarItems: [],
  calendarRange: null,
  calendarSelectedDate: null,
  ws: null,

  async init(token, me) {
    setToken(token)
    set({ token, me, ready: false })
    const existing = get().ws
    if (existing) existing.close()
    const ws = new WsClient({
      handler: (env) => get().applyWsEvent(env),
      onReconnect: () => {
        get().refetchDirectory()
        get().loadMentions()
        get().loadInboxAndPrefs()
        const cur = get().currentChannelId
        if (cur) get().loadMessages(cur)
        for (const channelId of Object.keys(get().channelVoiceTriggers)) {
          void get().loadChannelVoiceTriggers(channelId).catch(() => {})
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
    await get().loadInboxAndPrefs()
    set({ ready: true })

    // If notifications are already granted, (re)subscribe to web push silently.
    if (isWebNotifyGranted()) void initPush()
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
      online: new Set(),
      myConnId: null,
      channels: [],
      currentChannelId: null,
      byChannel: {},
      gifConfig: null,
      duckActivity: {},
      members: {},
      channelVoiceTriggers: {},
      thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
      typing: {},
      quickSwitcherOpen: false,
      searchOpen: false,
      inboxOpen: false,
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

  async sendMessage(channelId, content, parentId, attachmentIds, replyToId) {
    try {
      const msg = await api.sendMessage(channelId, content, parentId, attachmentIds, replyToId)
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
    const msg = await api.editMessage(messageId, content)
    get().applyWsEvent({ type: 'message.updated', payload: { message: msg } })
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

    set({
      voice: {
        channelId,
        status: 'connecting',
        muted: false,
        noiseSuppression: storedNoiseSuppression(),
        noiseSuppressionAvailable: true,
        blurEnabled: storedVideoBlur(),
        handRaised: false,
        transcribing: false,
        roastArmed: false,
        speaking: {},
        cameraStatus: 'off',
        screenStatus: 'off',
        stageMode: opts?.stageMode ?? 'expanded',
        audioDeviceId: null,
        videoDeviceId: null,
        localStream: null,
        remoteStreams: {},
        localScreenStream: null,
        remoteScreenStreams: {},
        client: null,
      },
    })

    let client: VoiceClient | null = null
    try {
      const config = await api.voice.config()
      const pending = get().voice
      if (
        pending.channelId !== channelId ||
        pending.status !== 'connecting' ||
        pending.client
      ) {
        return
      }

      client = new VoiceClient({
        channelId,
        myConnId,
        myUserId: me.id,
        iceServers: config.ice_servers,
        noiseSuppression: get().voice.noiseSuppression,
        blurBackground: get().voice.blurEnabled,
        send: (type, payload) => get().ws!.send(type, payload),
        onSpeaking: (connId, speaking) => {
          set((s) => {
            if (s.voice.client !== client) return {}
            return {
              voice: {
                ...s.voice,
                speaking: { ...s.voice.speaking, [connId]: speaking },
              },
            }
          })
        },
        onLocalStream: (stream) => {
          set((s) => {
            const activeClient = s.voice.client
            if (!activeClient || activeClient !== client) return {}
            return {
              voice: {
                ...s.voice,
                localStream: stream,
                cameraStatus: stream ? 'on' : 'off',
                videoDeviceId: activeClient.getVideoDeviceId() ?? s.voice.videoDeviceId,
              },
            }
          })
        },
        onRemoteStream: (connId, stream) => {
          set((s) => {
            if (s.voice.client !== client) return {}
            const remoteStreams = { ...s.voice.remoteStreams }
            if (stream?.getVideoTracks().length) remoteStreams[connId] = stream
            else delete remoteStreams[connId]
            return { voice: { ...s.voice, remoteStreams } }
          })
        },
        onLocalScreen: (stream) => {
          set((s) => {
            if (s.voice.client !== client) return {}
            return {
              voice: {
                ...s.voice,
                localScreenStream: stream,
                screenStatus: stream ? 'on' : 'off',
              },
            }
          })
        },
        onRemoteScreen: (connId, stream) => {
          set((s) => {
            if (s.voice.client !== client) return {}
            const remoteScreenStreams = { ...s.voice.remoteScreenStreams }
            if (stream?.getVideoTracks().length) remoteScreenStreams[connId] = stream
            else delete remoteScreenStreams[connId]
            return { voice: { ...s.voice, remoteScreenStreams } }
          })
        },
        onNoiseSuppression: (available) => {
          set((s) => {
            if (s.voice.client !== client) return {}
            return { voice: { ...s.voice, noiseSuppressionAvailable: available } }
          })
        },
      })
      set((s) => ({ voice: { ...s.voice, client } }))

      await client.start()
      const active = get().voice
      const startedClient = active.client
      if (active.channelId !== channelId || !startedClient || startedClient !== client) {
        client.stop()
        return
      }
      set((s) => ({
        voice: {
          ...s.voice,
          audioDeviceId: startedClient.getAudioDeviceId(),
        },
      }))
      get().ws?.send('voice.join', {
        channel_id: channelId,
        ...(opts?.linkToken ? { link_token: opts.linkToken } : {}),
      })
    } catch (e) {
      client?.stop()
      const active = get().voice
      if (
        active.channelId === channelId &&
        (client === null ? active.client === null : active.client === client)
      ) {
        set({ voice: emptyVoiceState() })
      }
      if (e instanceof Error) toastError(e.message)
      else toastError('Could not join the voice room.')
    }
  },

  leaveVoice() {
    const { channelId, client, status } = get().voice
    if (channelId) get().ws?.send('voice.leave', { channel_id: channelId })
    stopVoiceRecognizer()
    client?.stop()
    set({ voice: emptyVoiceState() })
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

  // Purely local camera effect — no WS event. Persisted so the next call remembers
  // it; if the camera is live the client swaps the published track in place.
  toggleVoiceBlur() {
    const next = !get().voice.blurEnabled
    try {
      window.localStorage.setItem(VIDEO_BLUR_KEY, next ? '1' : '0')
    } catch {
      // ignore persistence failures (private mode etc.)
    }
    set((s) => ({ voice: { ...s.voice, blurEnabled: next } }))
    const { client } = get().voice
    if (!client) return
    void client.setBackgroundBlur(next).catch(() => {
      toastError('Could not toggle background blur.')
    })
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
    if (!isSpeechSupported() || !voice.channelId || voice.status !== 'connected') {
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
      onPhrase: (text) => {
        const current = get()
        if (!current.voice.transcribing || current.voice.channelId !== channelId) return
        current.ws?.send('voice.phrase', { channel_id: channelId, text })
      },
      onError: () => {
        if (voiceRecognizer !== recognizer) return
        voiceRecognizer = null
        const current = get()
        if (!current.voice.transcribing || current.voice.channelId !== channelId) return
        set((s) => ({ voice: { ...s.voice, transcribing: false } }))
        current.ws?.send('voice.transcribe', { channel_id: channelId, enabled: false })
        toastError('Speech recognition permission was denied.')
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
      set((s) => ({
        voice: { ...s.voice, audioDeviceId: client.getAudioDeviceId() },
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
      set((s) => ({
        voice: { ...s.voice, videoDeviceId: client.getVideoDeviceId() },
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
      const [inbox, prefs] = await Promise.all([api.notifications(), api.prefs()])
      set({
        notifications: inbox.notifications,
        notifUnread: inbox.unread_count,
        notifHasMore: inbox.notifications.length >= 30,
        dnd: prefs.dnd,
        mutedChannels: new Set(prefs.muted_channel_ids),
        chatLayout: prefs.chat_layout,
      })
    } catch (e) {
      if (e instanceof Error) toastError(e.message)
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

  async toggleMute(channelId) {
    const muted = new Set(get().mutedChannels)
    const nextMuted = !muted.has(channelId)
    if (nextMuted) muted.add(channelId)
    else muted.delete(channelId)
    set({ mutedChannels: muted })
    try {
      await api.setChannelMute(channelId, nextMuted)
    } catch (e) {
      const revert = new Set(get().mutedChannels)
      if (nextMuted) revert.delete(channelId)
      else revert.add(channelId)
      set({ mutedChannels: revert })
      if (e instanceof Error) toastError(e.message)
    }
  },

  async enableDesktopNotifications() {
    const granted = await requestNotifyPermission()
    set({ notifyEnabled: granted })
    if (granted) {
      await initPush()
    } else {
      toastError('Notification permission was not granted.')
    }
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
        }
        set({
          online: new Set(p.online_user_ids),
          myConnId: p.conn_id,
          voiceRooms: voiceRoomsFromSnapshots(p.voice_rooms),
          activeMeetings: activeMeetingsFromSnapshots(p.voice_rooms),
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
          ...(s.voice.channelId === p.channel_id
            ? {
                voice: {
                  ...s.voice,
                  status: 'connected' as const,
                  speaking: {},
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
        if (joiningThisRoom) playVoiceJoinSound()
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
            p.participant.user_id !== me.id
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
            set({ voice: emptyVoiceState() })
          } else {
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
      case 'voice.signal': {
        const p = env.payload as VoiceSignalPayload
        const active = get().voice
        if (active.channelId === p.channel_id && active.client) {
          void active.client.onSignal(p).catch((error) => {
            console.error('Failed to handle voice signal', error)
          })
        }
        break
      }
      case 'voice.error': {
        const p = env.payload as VoiceErrorPayload
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
          set({ voice: emptyVoiceState(), guestRevoked: true, guestPendingJoin: false })
          toastError(voiceErrorMessage(p.code))
          break
        }
        stopVoiceRecognizer()
        get().voice.client?.stop()
        set({ voice: emptyVoiceState() })
        toastError(voiceErrorMessage(p.code))
        break
      }
      case 'message.created': {
        const { message, duck_streak } = env.payload as MessageCreatedPayload
        applyMessageCreated(set, message, me?.id ?? null, duck_streak)
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
        break
      }
      case 'message.deleted': {
        const p = env.payload as MessageDeletedPayload
        applyMessageDeleted(set, p)
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
        const prefix = mention.doc.kind === 'canvas' ? 'x' : 'd'
        const deepLink = `/${prefix}/${mention.doc.id}`
        const viewing =
          typeof window !== 'undefined' &&
          window.location.pathname === deepLink
        if (!viewing && !get().dnd) {
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
        if (!st.dnd && !focusedHere) {
          const title =
            notification.kind === 'dm'
              ? notification.actor.display_name
              : `${notification.actor.display_name} in #${notification.channel_name}`
          const cid = notification.channel_id
          const preview = gifPreviewText(notification.preview)
          toastNotify(preview || 'sent you a message', {
            title,
            initial: notification.actor.display_name.trim().charAt(0).toUpperCase() || '?',
            onClick: cid ? () => navigateToChannel(cid) : undefined,
          })
          playNotifySound()
          void showOsNotification(title, preview, {
            deepLink: `/c/${cid}`,
            tag: `sharp-${cid}`,
          })
        }
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
        if (get().dnd) break
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

function voiceErrorMessage(code: string): string {
  switch (code) {
    case 'room_full':
      return 'This voice room is full.'
    case 'not_member':
      return 'You do not have access to this call.'
    case 'not_in_room':
      return 'You are no longer in this voice room.'
    case 'camera_full':
      return 'Four cameras are already active. You are still connected by audio.'
    case 'screen_taken':
      return 'Someone else is already sharing their screen.'
    case 'link_revoked':
      return 'This call link is no longer valid.'
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
    return list.map((m) => (m.id === msg.id ? msg : m))
  }
  if (list.length === 0 || cmpId(msg.id, list[list.length - 1].id) > 0) {
    return [...list, msg]
  }
  const next = [...list, msg]
  next.sort((a, b) => cmpId(a.id, b.id))
  return next
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
          edited_at: message.edited_at,
          deleted_at: message.deleted_at,
          reactions: message.reactions,
          reply_count: message.reply_count,
          last_reply_at: message.last_reply_at,
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
