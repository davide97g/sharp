// Wire types — copied verbatim from docs/ARCHITECTURE.md ("Wire types (JSON)").
// All ids (including message bigints) are serialized as strings. Timestamps are RFC3339 UTC.

export type User = {
  id: string
  email: string
  display_name: string
  created_at: string
}

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
}

// --- REST response shapes ---

export type AuthResponse = { token: string; user: User }
export type UsersResponse = { users: User[]; online_user_ids: string[] }
export type ChannelsResponse = { channels: Channel[] }
export type MembersResponse = { members: User[] }
export type MessagesResponse = { messages: Message[] }
export type ThreadResponse = { parent: Message; replies: Message[] }
export type SearchResult = Message & { channel_name: string }
export type SearchResponse = { results: SearchResult[] }
export type NotificationsResponse = {
  notifications: Notification[]
  unread_count: number
}
export type VapidResponse = { public_key: string | null }

export type ApiError = { error: { code: string; message: string } }

// --- WebSocket envelope ---

export type WsEnvelope<P = unknown> = { type: string; payload: P }

export type HelloPayload = { user_id: string; online_user_ids: string[] }
export type MessageCreatedPayload = { message: Message }
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
export type ChannelCreatedPayload = { channel: Channel }
export type ChannelMemberPayload = { channel_id: string; user: User }

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
  doc: { id: string; title: string; icon: string; channel_id: string }
  from_user: { id: string; display_name: string }
  created_at: string
  read_at: string | null
}

// Doc REST response shapes
export type DocsResponse = { docs: Doc[] }
export type DocRoleEntry = { user: User; role: 'editor' | 'viewer' | 'none' }
export type DocRolesResponse = { roles: DocRoleEntry[] }
export type DocMentionsResponse = { mentions: DocMention[] }
export type DocSearchResult = Doc & { channel_name: string }
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
