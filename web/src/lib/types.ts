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
  reply_count: number
  last_reply_at: string | null
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
export type TypingPayload = {
  channel_id: string
  user_id: string
  display_name: string
}
export type PresencePayload = { user_id: string; status: 'online' | 'offline' }
