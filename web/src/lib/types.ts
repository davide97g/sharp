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

export type Channel = {
  id: string
  name: string
  kind: ChannelKind
  topic: string
  created_by: string | null
  created_at: string
  is_member: boolean
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
}

export type Message = {
  id: string
  channel_id: string
  parent_id: string | null
  user: MessageAuthor
  content: string // '' when deleted
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  reactions: Reaction[]
  attachments: Attachment[]
  reply_count: number
  last_reply_at: string | null
  reply_to: ReplyPreview | null
}

export type NotificationKind = 'mention' | 'dm' | 'reply'

export type Notification = {
  id: string
  kind: NotificationKind
  actor: MessageAuthor
  channel_id: string
  channel_kind: ChannelKind
  channel_name: string
  message_id: string | null
  preview: string
  created_at: string
  read_at: string | null
}

export type Prefs = {
  dnd: boolean
  muted_channel_ids: string[]
  chat_layout: ChatLayout | null
}

// --- REST response shapes ---

export type AuthResponse = { token: string; user: User }
export type UsersResponse = { users: User[]; online_user_ids: string[] }
export type ChannelsResponse = { channels: Channel[] }
export type MembersResponse = { members: User[] }
export type MessagesResponse = { messages: Message[] }
export type ThreadResponse = { parent: Message; replies: Message[] }
export type SearchResult = Message & { channel_name: string; snippet: string }
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
export type NotificationsResponse = {
  notifications: Notification[]
  unread_count: number
}
export type VapidResponse = { public_key: string | null }
export type IceConfigResponse = { ice_servers: RTCIceServer[] }

// --- Public guest call links ---
export type VoiceLinkResponse = { token: string | null }
export type VoiceLinkCreateResponse = { token: string }
export type CallLinkInfoResponse = { channel_name: string }
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
  // True for unregistered visitors who joined via a public call link.
  guest: boolean
  muted: boolean
  transcribing: boolean
  camera_on: boolean
  screen_on: boolean
  screen_stream_id: string | null
}

export type VoiceRoomSnapshot = {
  channel_id: string
  participants: VoiceParticipant[]
}

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
export type ChannelMemberPayload = { channel_id: string; user: User }
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
export type VoiceSignalPayload = {
  channel_id: string
  from_user: string
  from_conn: string
  to_user: string
  to_conn: string
  kind: 'offer' | 'answer' | 'candidate'
  data: unknown
}
export type VoiceErrorPayload = { channel_id: string; code: string }

// --- Phase 2: Docs ---

export type DocRole = 'owner' | 'editor' | 'viewer' | 'none'
export type DocKind = 'doc' | 'canvas'

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
  everyone_role: 'editor' | 'viewer' | 'none'
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
export type TypingPayload = {
  channel_id: string
  user_id: string
  display_name: string
}
export type PresencePayload = { user_id: string; status: 'online' | 'offline' }
export type NotificationCreatedPayload = { notification: Notification }
