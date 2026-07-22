// Wire types — copied verbatim from docs/ARCHITECTURE.md ("Wire types (JSON)").
// All ids (including message bigints) are serialized as strings. Timestamps are RFC3339 UTC.

export type User = {
  id: string
  // Private: present only on the signed-in user's own record. The server omits
  // it for every other viewer, so it's optional here.
  email?: string
  display_name: string
  avatar_url: string | null
  created_at: string
}

export type DesktopCodeResponse = {
  code: string
  expires_in: number
}

export type ChatLayout = 'bubble' | 'classic'

export type ChannelKind = 'public' | 'private' | 'dm'
export type ChannelRole = 'owner' | 'editor' | 'viewer'

export type Channel = {
  id: string
  name: string
  kind: ChannelKind
  topic: string
  created_by: string | null
  created_at: string
  is_member: boolean
  my_role: ChannelRole | null
  unread_count: number
  last_message_at: string | null
  dm_user: User | null
}

export type Reaction = {
  emoji: string
  count: number
  me: boolean
}

export type Attachment = {
  id: string
  filename: string
  content_type: string
  size: number
  url: string // proxied download path, e.g. /api/v1/files/<id>
  encrypted: boolean
  decryption?: { key: string; nonce: string }
}

export type MessageAuthor = {
  id: string
  display_name: string
  avatar_url: string | null
}

export type ReplyPreview = {
  id: string
  user: MessageAuthor
  content: string // truncated preview; '' when the target was deleted
  deleted: boolean
  encrypted: boolean
}

export type Message = {
  id: string
  channel_id: string
  parent_id: string | null
  user: MessageAuthor
  content: string // '' when deleted
  encrypted: boolean
  // Only encrypted messages use this field: undefined while decrypting, null on failure.
  decryptedText?: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  reactions: Reaction[]
  attachments: Attachment[]
  reply_count: number
  last_reply_at: string | null
  reply_to: ReplyPreview | null
}

export type NotificationKind =
  | 'mention'
  | 'dm'
  | 'reply'
  | 'poll_ended'
  | 'task_assigned'
  | 'task_comment'

// Message kinds carry a channel; task kinds carry a task instead.
export type Notification = {
  id: string
  kind: NotificationKind
  actor: MessageAuthor
  channel_id: string | null
  channel_kind: ChannelKind | null
  channel_name: string | null
  message_id: string | null
  task_id: string | null
  task_identifier: string | null // "SHARP-123" — deep link derives from this
  preview: string
  created_at: string
  read_at: string | null
}

/** /t/{key}/{num} for task notifications, /c/{channel} otherwise. */
export function notificationPath(n: Notification): string {
  if (n.task_identifier) {
    const at = n.task_identifier.lastIndexOf('-')
    if (at > 0) {
      return `/t/${n.task_identifier.slice(0, at).toLowerCase()}/${n.task_identifier.slice(at + 1)}`
    }
  }
  return n.channel_id ? `/c/${n.channel_id}` : '/'
}

export type ChannelNotifyMode = 'all' | 'mentions' | 'muted'

export type Prefs = {
  dnd: boolean
  muted_channel_ids: string[]
  channel_modes: Record<string, ChannelNotifyMode>
  chat_layout: ChatLayout | null
  notify_dm: boolean
  notify_mention: boolean
  notify_reply: boolean
  notify_task: boolean
  notify_poll: boolean
  dnd_scheduled: boolean
  dnd_start: number | null // minutes-of-day, local time
  dnd_end: number | null
  tz_offset: number // minutes east of UTC
}

/** Partial update accepted by PUT /prefs. */
export type PrefsUpdate = Partial<
  Pick<
    Prefs,
    | 'notify_dm'
    | 'notify_mention'
    | 'notify_reply'
    | 'notify_task'
    | 'notify_poll'
    | 'dnd_scheduled'
    | 'dnd_start'
    | 'dnd_end'
    | 'tz_offset'
  >
>

export type E2eeDevice = {
  id: string
  user_id: string
  name: string
  x25519_pub: string
  ed25519_pub: string
  created_at: string
}

export type E2eeDevicesResponse = { devices: E2eeDevice[] }

export type EncryptedAttachment = {
  id: string
  key: string
  nonce: string
  filename: string
  content_type: string
}

export type EncryptedBody = {
  text: string
  attachments?: EncryptedAttachment[]
}

export type E2eeBackupInput = {
  salt: string
  nonce: string
  ciphertext: string
}

export type E2eeBackup = E2eeBackupInput & { updated_at: string }

// --- REST response shapes ---

export type AuthResponse = { token: string; user: User }

export type PasskeyConfig = { enabled: boolean; rp_name: string | null }
export type PasskeyRecord = {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}
export type PasskeyList = {
  enabled: boolean
  prompt_dismissed: boolean
  passkeys: PasskeyRecord[]
}
export type PasskeyChallenge = { ceremony_id: string; options: { publicKey: unknown } }
export type PasskeyManageStart = { code: string; expires_in: number }
export type UsersResponse = { users: User[]; online_user_ids: string[] }
export type ChannelsResponse = { channels: Channel[] }
export type ChannelMember = User & { role: ChannelRole }
export type MembersResponse = { members: ChannelMember[] }
export type MessagesResponse = { messages: Message[] }
export type ThreadResponse = { parent: Message; replies: Message[] }
export type SearchResult = Message & { channel_name: string; snippet: string; local?: boolean }
export type SearchResponse = { results: SearchResult[] }
export type GifResult = {
  id: string
  url: string
  preview_url: string
  width: number
  height: number
  title: string
}
export type GifConfig = {
  enabled: boolean
  duck: boolean
  provider?: string
  duck_cooldown_secs: number
  duck_context: DuckContext
}
export type DuckContext = '1m' | '2m' | '3m'
export type DuckCooldownSecs = 30 | 60 | 120 | 300
export type GiphyUsage = {
  used: number
  limit: number
  /** ISO timestamp when the oldest call ages out; null when unused. */
  resets_at: string | null
}
export type GifSettings = {
  provider: string
  has_api_key: boolean
  duck_enabled: boolean
  duck_cooldown_secs: DuckCooldownSecs
  duck_context: DuckContext
  deepseek_configured: boolean
  giphy_usage: GiphyUsage
}
export type GifSuggestResponse = { query: string | null; results: GifResult[] }
export type VoiceTrigger = {
  id: string
  channel_id: string | null
  user_id: string
  phrase: string
  action: string
  created_at: string
}
export type VoiceTriggersResponse = { triggers: VoiceTrigger[] }
export type NotificationsResponse = {
  notifications: Notification[]
  unread_count: number
}
export type VapidResponse = { public_key: string | null }
export type VoiceConfigResponse = {
  provider: 'livekit'
  available: boolean
  server_url: string | null
  transcription: boolean
}
export type TranscriptionResponse = { text: string }

// --- Public guest call links ---
export type VoiceLinkResponse = { token: string | null }
export type VoiceLinkCreateResponse = { token: string }
export type CallLinkInfoResponse = {
  room_id: string
  room_kind: ChannelKind | 'standalone'
  channel_name: string
}
export type StandaloneCallCreateResponse = {
  room_id: string
  token: string
  title: string
}
export type CallLinkJoinResponse = {
  token: string // guest JWT (12h)
  channel_id: string
  user_id: string
  name: string
}

export type ApiError = { error: { code: string; message: string } }

// --- WebSocket envelope ---

export type WsEnvelope<P = unknown> = { type: string; payload: P }

export type VoiceParticipant = {
  conn_id: string
  user_id: string
  // Server-filled for every participant (members + guests).
  display_name: string
  // Server-assigned drawing color (CSS hex, e.g. "#f97316"), stable for the session.
  annotation_color: string
  // True for unregistered visitors who joined via a public call link.
  guest: boolean
  muted: boolean
  transcribing: boolean
  camera_on: boolean
  screen_on: boolean
  screen_stream_id: string | null
  hand_raised: boolean
  // Unix epoch milliseconds when the hand was raised; null while lowered.
  hand_raised_at: number | null
  joined_at: string
}

export type VoiceRoomSnapshot = {
  channel_id: string
  participants: VoiceParticipant[]
  active_meeting_id: string | null
  poll: CallPoll | null
  // Whether non-sharers may currently draw on the active screen share.
  annotations_allowed: boolean
  // Present only in the private voice.state response to the joining connection.
  media?: {
    provider: 'livekit'
    server_url: string
    participant_token: string
    participant_identity: string
  }
}

export type PollVoter = {
  id: string
  display_name: string
}

export type PollOption = {
  id: string
  position: number
  text: string
  count: number
  voters: PollVoter[]
}

export type Poll = {
  id: string
  channel_id: string
  creator_id: string
  card_message_id: string | null
  question: string
  multi: boolean
  pinned: boolean
  expires_at: string | null
  closed_at: string | null
  closed_reason: 'manual' | 'expired' | null
  deleted: boolean
  created_at: string
  options: PollOption[]
  my_votes: string[]
  total_voters: number
}

export type CallPollVoter = {
  id: string
  display_name: string
  guest: boolean
}

export type CallPollOption = {
  id: string
  text: string
  count: number
  voters: CallPollVoter[]
}

export type CallPoll = {
  id: string
  room_id: string
  question: string
  multi: boolean
  persistent_poll_id: string | null
  creator_id: string
  expires_at: string | null
  closed: boolean
  options: CallPollOption[]
  my_votes: null
}

export type MeetingStatus = 'active' | 'completed' | 'interrupted'
export type MeetingSummaryStatus = 'pending' | 'ready' | 'failed' | 'unavailable'

export type MeetingListItem = {
  id: string
  channel_id: string
  channel_name: string
  channel_kind: ChannelKind | 'standalone'
  title: string
  status: MeetingStatus
  summary_status: MeetingSummaryStatus
  started_at: string
  ended_at: string | null
  participant_count: number
  transcript_count: number
}

export type MeetingAttendance = {
  id: string
  user_id: string | null
  display_name: string
  guest: boolean
  joined_at: string
  left_at: string | null
}

export type MeetingTranscriptPhrase = {
  id: string
  attendance_id: string | null
  user_id: string | null
  display_name: string
  guest: boolean
  text: string
  spoken_at: string
}

export type MeetingAction = {
  id: string
  text: string
  assignee_user_id: string | null
  assignee_name: string | null
  completed: boolean
  position: number
}

export type MeetingDetail = MeetingListItem & {
  summary: string
  decisions: string
  created_at: string
  updated_at: string
  attendance: MeetingAttendance[]
  transcript: MeetingTranscriptPhrase[]
  actions: MeetingAction[]
}

export type MeetingsResponse = { meetings: MeetingListItem[] }

export type HelloPayload = {
  user_id: string
  online_user_ids: string[]
  conn_id: string
  voice_rooms: VoiceRoomSnapshot[]
}
export type DuckStreakSnapshot = { count: number; last_at: string }
export type MessageCreatedPayload = {
  message: Message
  duck_streak?: DuckStreakSnapshot
}
export type DuckStreakPayload = {
  channel_id: string
  duck_streak: DuckStreakSnapshot
}
export type MessageUpdatedPayload = { message: Message }
export type E2eeDevicesChangedPayload = { user_id: string }
export type MessageDeletedPayload = {
  message_id: string
  channel_id: string
  parent_id: string | null
}
export type ReactionPayload = {
  message_id: string
  channel_id: string
  emoji: string
  user_id: string
}
export type UserUpdatedPayload = { user: User }
export type ChannelCreatedPayload = { channel: Channel }
export type ChannelUpdatedPayload = { channel: Channel }
export type ChannelDeletedPayload = { channel_id: string }
export type ChannelMemberPayload = { channel_id: string; user: User; role: ChannelRole }
export type ChannelMemberUpdatedPayload = {
  channel_id: string
  user_id: string
  role: ChannelRole
}
export type VoiceStatePayload = VoiceRoomSnapshot
export type VoiceParticipantJoinedPayload = {
  channel_id: string
  participant: VoiceParticipant
}
export type VoiceParticipantLeftPayload = {
  channel_id: string
  conn_id: string
  user_id: string
}
export type VoiceParticipantUpdatedPayload = {
  channel_id: string
  participant: VoiceParticipant
}
export type VoiceErrorPayload = { channel_id: string; code: string }
// Screen-share annotation relays (server -> client).
export type VoiceAnnotatePayload = {
  channel_id: string
  conn_id: string
  user_id: string
  color: string
  stroke_id: string
  kind: 'start' | 'points' | 'end'
  points: [number, number][]
  size?: number
}
export type VoiceAnnotateClearPayload = { channel_id: string }
export type VoiceAnnotateStatePayload = { channel_id: string; allowed: boolean }
export type VoiceTriggerCreatedPayload = { channel_id: string; trigger: VoiceTrigger }
export type VoiceTriggerDeletedPayload = { channel_id: string; trigger_id: string }
export type VoiceTriggerFiredPayload = {
  channel_id: string
  user_id: string
  display_name: string
  phrase: string
}
export type MeetingStartedPayload = {
  meeting_id: string
  channel_id: string
  started_at: string
}
export type MeetingEndedPayload = {
  meeting_id: string
  channel_id: string
  ended_at: string
  status: 'completed' | 'interrupted'
}

// --- Phase 2: Docs ---

export type DocRole = 'owner' | 'editor' | 'viewer' | 'none'
export type DocKind = 'doc' | 'canvas' | 'board'

export type Doc = {
  id: string
  channel_id: string
  kind: DocKind
  title: string
  icon: string
  created_by: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
  everyone_role: 'editor' | 'viewer' | 'none' | 'inherit'
  my_role: DocRole // resolved for the requesting/receiving user
  preview: string // first 160 chars of content_text
}

export type DocMention = {
  id: string
  doc: { id: string; kind: DocKind; title: string; icon: string; channel_id: string }
  from_user: { id: string; display_name: string }
  created_at: string
  read_at: string | null
}

// Doc REST response shapes
export type DocsResponse = { docs: Doc[] }
export type DocRoleEntry = { user: User; role: 'editor' | 'viewer' | 'none' }
export type DocRolesResponse = { roles: DocRoleEntry[] }
export type DocMentionsResponse = { mentions: DocMention[] }
export type DocSearchResult = Doc & { channel_name: string; snippet: string }
export type DocSearchResponse = { results: DocSearchResult[] }

// Doc WS payloads
export type DocCreatedPayload = { doc: Doc }
export type DocUpdatedPayload = { doc: Doc }
export type DocDeletedPayload = {
  doc_id: string
  channel_id: string
  permanent: boolean
}
export type DocMentionPayload = { mention: DocMention }

// --- Phase 5: Calendar ---

export type CalendarCalendar = {
  id: string
  external_id: string
  summary: string
  color: string | null
  is_primary: boolean
  selected: boolean
}

export type CalendarConnection = {
  id: string
  provider: 'google'
  provider_email: string
  status: 'active' | 'invalid'
  last_synced_at: string | null
  calendars: CalendarCalendar[]
}

export type MeetingAttendee = {
  user_id: string
  display_name: string
  response: string
}

export type ScheduledMeeting = {
  id: string
  channel_id: string | null
  standalone_call_id: string | null
  creator: { id: string; display_name: string; avatar_url: string | null }
  title: string
  description: string
  start_at: string
  end_at: string
  all_day: boolean
  status: 'scheduled' | 'cancelled'
  join_path: string | null
  attendees: MeetingAttendee[]
  my_response: string | null
}

export type CalendarItem =
  | {
      source: 'google'
      id: string
      calendar_id: string
      title: string
      description: string | null
      location: string | null
      start_at: string
      end_at: string
      all_day: boolean
      html_link: string | null
      color: string | null
    }
  | {
      source: 'native'
      id: string
      title: string
      start_at: string
      end_at: string
      all_day: boolean
      join_path: string | null
      meeting: ScheduledMeeting
    }

// Calendar REST response shapes
export type CalendarConnectionsResponse = { connections: CalendarConnection[] }
export type CalendarConnectUrlResponse = { url: string }
export type CalendarEventsResponse = { events: CalendarItem[] }

// Calendar WS payloads
export type CalendarMeetingCreatedPayload = { meeting: ScheduledMeeting }
export type CalendarMeetingUpdatedPayload = { meeting: ScheduledMeeting }
export type CalendarMeetingCancelledPayload = { meeting_id: string }
export type CalendarSyncedPayload = { account_id: string; last_synced_at: string }
export type CalendarReminderPayload = {
  kind: 'lead' | 'start'
  title: string
  start_at: string
  join_path: string | null
  source: 'google' | 'native'
  ref_id: string
}

export type TypingPayload = {
  channel_id: string
  user_id: string
  display_name: string
}
export type PresencePayload = { user_id: string; status: 'online' | 'offline' }
export type NotificationCreatedPayload = { notification: Notification }
export type PollCreatedPayload = { poll: Poll }
export type PollUpdatedPayload = { poll: Poll }
export type PollDeletedPayload = {
  poll_id: string
  channel_id: string
  message_id: string | null
}
export type VoicePollStatePayload = { room_id: string; poll: CallPoll | null }

// --- Sharpy: AI workspace assistant ---

export type SharpyConversation = {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export type SharpySource =
  | {
      kind: 'message'
      message_id: string
      channel_id: string
      channel_name: string
      author: string
      snippet: string
      created_at: string
    }
  | {
      kind: 'doc'
      doc_id: string
      title: string
      doc_kind: 'doc' | 'canvas' | 'board'
      snippet: string
    }
  | {
      kind: 'task'
      task_id: string
      identifier: string
      title: string
      snippet: string
    }

export type SharpyMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: SharpySource[] | null
  created_at: string
}

// REST response shapes
export type SharpyStatusResponse = { enabled: boolean }
export type SharpyConversationDetail = {
  conversation: SharpyConversation
  messages: SharpyMessage[]
}

// SSE stream frames (POST .../messages)
export type SharpyStreamEvent =
  | { type: 'sources'; sources: SharpySource[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: SharpyMessage }
  | { type: 'error'; message: string }

// --- Tasks (Phase 7 — Linear-lite planner) ---

export type TaskStateType = 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export type TaskState = {
  id: string
  project_id: string
  name: string
  color: string // board palette key
  type: TaskStateType
  position: number
}

export type Project = {
  id: string
  key: string
  name: string
  icon: string
  channel_id: string | null
  created_by: string
  archived_at: string | null
  created_at: string
  states: TaskState[]
  open_count: number
}

export type TaskGithubLink = {
  id: string
  kind: 'branch' | 'pr' | 'issue'
  repo: string
  ref: string
  url: string
  title: string
  state: string // '' | 'open' | 'draft' | 'merged' | 'closed'
  created_at: string
}

// 0 none, 1 urgent, 2 high, 3 medium, 4 low (Linear order)
export type TaskPriority = 0 | 1 | 2 | 3 | 4

export type Task = {
  id: string
  project_id: string
  number: number
  identifier: string // "SHARP-123", precomputed server-side
  title: string
  description: string
  state_id: string
  priority: TaskPriority
  assignee_id: string | null
  creator_id: string
  parent_id: string | null
  due_date: string | null // YYYY-MM-DD
  sort_order: string
  source_message_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  label_ids: string[]
  github_links: TaskGithubLink[]
  comment_count: number
  sub_count: number
}

export type TaskComment = {
  id: string
  task_id: string
  author: MessageAuthor
  body: string
  created_at: string
  updated_at: string | null
  deleted: boolean
}

export type TaskActivity = {
  id: string
  task_id: string
  actor: MessageAuthor | null // null = automation (GitHub)
  kind: string
  payload: Record<string, unknown>
  created_at: string
}

export type TaskDetail = Task & {
  comments: TaskComment[]
  activity: TaskActivity[]
  sub_tasks: Task[]
}

export type TaskLabel = {
  id: string
  name: string
  color: string
}

export type TaskCreateInput = {
  title: string
  description?: string
  state_id?: string
  priority?: TaskPriority
  assignee_id?: string
  label_ids?: string[]
  due_date?: string
  parent_id?: string
  source_message_id?: string
}

export type TaskUpdateInput = {
  title?: string
  description?: string
  state_id?: string
  priority?: TaskPriority
  assignee_id?: string | null
  label_ids?: string[]
  due_date?: string | null
  parent_id?: string | null
  sort_order?: string
}

// WS payloads
export type ProjectCreatedPayload = { project: Project }
export type ProjectUpdatedPayload = { project: Project }
export type TaskCreatedPayload = { task: Task }
export type TaskUpdatedPayload = { task: Task }
export type TaskDeletedPayload = { task_id: string; project_id: string }
export type TaskCommentPayload = { comment: TaskComment }
