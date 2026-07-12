import { create } from 'zustand'
import { api, clearToken, setToken } from './lib/api'
import { WsClient } from './lib/ws'
import { cmpId } from './lib/util'
import { toastError } from './lib/toast'
import type {
  Channel,
  ChannelCreatedPayload,
  ChannelMemberPayload,
  HelloPayload,
  Message,
  MessageCreatedPayload,
  MessageDeletedPayload,
  MessageUpdatedPayload,
  PresencePayload,
  ReactionPayload,
  TypingPayload,
  User,
  WsEnvelope,
} from './lib/types'

const PAGE = 50

type TypingEntry = { display_name: string; expiresAt: number }

type ThreadState = {
  open: boolean
  parentId: string | null
  parent: Message | null
  replies: Message[]
  loading: boolean
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

  // directory
  users: Record<string, User>
  online: Set<string>

  // channels
  channels: Channel[]
  currentChannelId: string | null

  // messages keyed by channel id
  byChannel: Record<string, ChannelMessages>

  // members cache keyed by channel id
  members: Record<string, User[]>

  // thread panel
  thread: ThreadState

  // typing: channelId -> userId -> entry
  typing: Record<string, Record<string, TypingEntry>>

  // quick switcher
  quickSwitcherOpen: boolean

  // ws
  ws: WsClient | null

  // --- actions ---
  init: (token: string, me: User) => Promise<void>
  logout: () => void
  refetchDirectory: () => Promise<void>

  setCurrentChannel: (id: string | null) => void
  loadMessages: (channelId: string) => Promise<void>
  loadOlder: (channelId: string) => Promise<void>
  sendMessage: (channelId: string, content: string, parentId?: string) => Promise<void>
  markRead: (channelId: string, messageId: string) => void

  createChannel: (input: {
    name: string
    kind: 'public' | 'private'
    topic?: string
    member_ids?: string[]
  }) => Promise<Channel>
  joinChannel: (id: string) => Promise<void>
  leaveChannel: (id: string) => Promise<void>
  openDm: (userId: string) => Promise<Channel>
  loadMembers: (id: string) => Promise<void>

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
  sendTyping: (channelId: string) => void
  pruneTyping: () => void

  applyWsEvent: (env: WsEnvelope) => void
  totalUnread: () => number
}

function emptyChannelMessages(): ChannelMessages {
  return { list: [], loaded: false, loading: false, hasMore: true }
}

export const useStore = create<State>((set, get) => ({
  token: null,
  me: null,
  ready: false,
  users: {},
  online: new Set(),
  channels: [],
  currentChannelId: null,
  byChannel: {},
  members: {},
  thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
  typing: {},
  quickSwitcherOpen: false,
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
        const cur = get().currentChannelId
        if (cur) get().loadMessages(cur)
      },
    })
    set({ ws })
    ws.connect()

    await get().refetchDirectory()
    set({ ready: true })
  },

  logout() {
    const ws = get().ws
    if (ws) ws.close()
    clearToken()
    set({
      token: null,
      me: null,
      ready: false,
      users: {},
      online: new Set(),
      channels: [],
      currentChannelId: null,
      byChannel: {},
      members: {},
      thread: { open: false, parentId: null, parent: null, replies: [], loading: false },
      typing: {},
      quickSwitcherOpen: false,
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

  setCurrentChannel(id) {
    set({ currentChannelId: id })
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

  async sendMessage(channelId, content, parentId) {
    try {
      const msg = await api.sendMessage(channelId, content, parentId)
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

  totalUnread() {
    return get().channels.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  },

  applyWsEvent(env) {
    const me = get().me
    switch (env.type) {
      case 'hello': {
        const p = env.payload as HelloPayload
        set({ online: new Set(p.online_user_ids) })
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
      case 'message.created': {
        const { message } = env.payload as MessageCreatedPayload
        applyMessageCreated(set, message, me?.id ?? null)
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
      case 'channel.created': {
        const { channel } = env.payload as ChannelCreatedPayload
        set((s) => ({
          channels: s.channels.some((c) => c.id === channel.id)
            ? s.channels.map((c) => (c.id === channel.id ? channel : c))
            : [...s.channels, channel],
        }))
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
              c.id === p.channel_id ? { ...c, is_member: true } : c,
            )
          }
          return {
            users,
            channels,
            members: members
              ? {
                  ...s.members,
                  [p.channel_id]: members.some((m) => m.id === p.user.id)
                    ? members
                    : [...members, p.user],
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
              c.id === p.channel_id ? { ...c, is_member: false } : c,
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
      default:
        break
    }
  },
}))

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

function applyMessageCreated(set: Setter, message: Message, myId: string | null) {
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
    return { byChannel, channels }
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
}
