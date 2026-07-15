import { create } from 'zustand'

import { api } from './lib/api'
import type { Channel, ChatLayout, HelloPayload, Message, Notification, PresencePayload, ReactionPayload, TypingPayload, User, WsEnvelope } from './lib/types'
import { WsClient } from './lib/ws'
import { cmpId } from './lib/util'
import { presentLocalNotification } from './lib/push'

const PAGE = 50
type TypingEntry = { display_name: string; expiresAt: number }
export type ChannelMessages = { list: Message[]; loaded: boolean; loading: boolean; hasMore: boolean }
const emptyMessages = (): ChannelMessages => ({ list: [], loaded: false, loading: false, hasMore: true })
export type ThreadState = { parentId: string | null; parent: Message | null; replies: Message[]; loading: boolean }

let displayNamesUsers: Record<string, User> | null = null
let displayNames: string[] = []
export function selectDisplayNames(users: Record<string, User>): string[] {
  if (users !== displayNamesUsers) {
    displayNamesUsers = users
    displayNames = Object.values(users).map((user) => user.display_name)
  }
  return displayNames
}

type State = {
  me: User | null; token: string | null; tokenReady: boolean
  users: Record<string, User>; online: Set<string>; channels: Channel[]; currentChannelId: string | null
  byChannel: Record<string, ChannelMessages>; members: Record<string, User[]>; typing: Record<string, Record<string, TypingEntry>>
  thread: ThreadState; drafts: Record<string, string>; replyTargets: Record<string, Message>; focusRequest: { key: string; n: number } | null
  notifications: Notification[]; notifUnread: number; notifHasMore: boolean; dnd: boolean; mutedChannels: Set<string>; chatLayout: ChatLayout | null; ws: WsClient | null; wsConnected: boolean
  setSession: (token: string, me: User) => void; clearSession: () => void; setTokenReady: (ready: boolean) => void
  init: () => Promise<void>; refetchDirectory: () => Promise<void>; loadInboxAndPrefs: () => Promise<void>; loadMoreNotifications: () => Promise<void>; markNotifRead: (id: string) => void; markAllNotifRead: () => void; setDnd: (dnd: boolean) => Promise<void>; setChatLayout: (layout: ChatLayout) => Promise<void>; updateProfile: (input: { display_name?: string }) => Promise<void>; uploadAvatar: (file: Blob) => Promise<void>; removeAvatar: () => Promise<void>
  setCurrentChannel: (id: string | null) => void; loadMessages: (id: string) => Promise<void>; loadOlder: (id: string) => Promise<void>
  markRead: (id: string, messageId: string) => void; openDm: (userId: string) => Promise<Channel>; loadMembers: (id: string) => Promise<void>
  sendMessage: (channelId: string, content: string, parentId?: string, attachmentIds?: string[], replyToId?: string) => Promise<void>
  toggleReaction: (message: Message, emoji: string) => Promise<void>; editMessage: (id: string, content: string) => Promise<void>; deleteMessage: (id: string) => Promise<void>
  openThread: (id: string) => Promise<void>; closeThread: () => void; setDraft: (key: string, value: string) => void; setReplyTarget: (channelId: string, message: Message | null) => void; requestComposerFocus: (key: string) => void; sendTyping: (channelId: string) => void; toggleMute: (id: string) => Promise<void>
  applyWsEvent: (env: WsEnvelope) => void; pruneTyping: () => void; totalUnread: () => number
}

export const useStore = create<State>((set, get) => ({
  me: null, token: null, tokenReady: false, users: {}, online: new Set(), channels: [], currentChannelId: null,
  byChannel: {}, members: {}, typing: {}, thread: { parentId: null, parent: null, replies: [], loading: false }, drafts: {}, replyTargets: {}, focusRequest: null, notifications: [], notifUnread: 0, notifHasMore: false, dnd: false, mutedChannels: new Set(), chatLayout: null, ws: null, wsConnected: false,
  setSession: (token, me) => set({ token, me }),
  clearSession: () => { get().ws?.close(); set({ token: null, me: null, users: {}, online: new Set(), channels: [], currentChannelId: null, byChannel: {}, members: {}, typing: {}, thread: { parentId: null, parent: null, replies: [], loading: false }, drafts: {}, replyTargets: {}, focusRequest: null, notifications: [], notifUnread: 0, notifHasMore: false, dnd: false, mutedChannels: new Set(), chatLayout: null, ws: null, wsConnected: false }) },
  setTokenReady: (tokenReady) => set({ tokenReady }),
  async init() {
    get().ws?.close()
    const ws = new WsClient({ handler: (env) => get().applyWsEvent(env), onOpen: () => set({ wsConnected: true }), onClose: () => set({ wsConnected: false }), onReconnect: () => { void get().refetchDirectory(); void get().loadInboxAndPrefs(); const id = get().currentChannelId; if (id) void get().loadMessages(id) } })
    set({ ws, wsConnected: false }); ws.connect()
    await Promise.all([get().refetchDirectory(), get().loadInboxAndPrefs()])
  },
  async refetchDirectory() {
    try { const [u, c] = await Promise.all([api.users(), api.channels()]); set({ users: Object.fromEntries(u.users.map((x) => [x.id, x])), online: new Set(u.online_user_ids), channels: c.channels }) } catch { /* request layer handles auth */ }
  },
  async loadInboxAndPrefs() {
    try { const [inbox, prefs] = await Promise.all([api.notifications(), api.prefs()]); set({ notifications: inbox.notifications, notifUnread: inbox.unread_count, notifHasMore: inbox.notifications.length >= 30, dnd: prefs.dnd, mutedChannels: new Set(prefs.muted_channel_ids), chatLayout: prefs.chat_layout }) } catch { /* inbox is best effort */ }
  },
  async loadMoreNotifications() { const current = get().notifications; if (!current.length || !get().notifHasMore) return; try { const res = await api.notifications(current[current.length - 1].id); set((s) => { const seen = new Set(s.notifications.map((n) => n.id)); return { notifications: [...s.notifications, ...res.notifications.filter((n) => !seen.has(n.id))], notifHasMore: res.notifications.length >= 30 } }) } catch {} },
  markNotifRead(id) { set((s) => { const item = s.notifications.find((n) => n.id === id); return { notifications: s.notifications.map((n) => n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n), notifUnread: item && !item.read_at ? Math.max(0, s.notifUnread - 1) : s.notifUnread } }); void api.markNotificationsRead({ ids: [id] }).catch(() => {}) },
  markAllNotifRead() { const now = new Date().toISOString(); set((s) => ({ notifications: s.notifications.map((n) => n.read_at ? n : { ...n, read_at: now }), notifUnread: 0 })); void api.markNotificationsRead({ all: true }).catch(() => {}) },
  async setDnd(dnd) { const prior = get().dnd; set({ dnd }); try { await api.setDnd(dnd) } catch { set({ dnd: prior }); throw new Error('Could not update Do Not Disturb') } },
  async setChatLayout(chatLayout) { const prior = get().chatLayout; set({ chatLayout }); try { await api.setChatLayout(chatLayout) } catch { set({ chatLayout: prior }); throw new Error('Could not update chat layout') } },
  async updateProfile(input) { const user = await api.updateProfile(input); set((s) => ({ me: user, users: { ...s.users, [user.id]: user } })) },
  async uploadAvatar(file) { const user = await api.uploadAvatar(file); set((s) => ({ me: user, users: { ...s.users, [user.id]: user } })) },
  async removeAvatar() { const user = await api.deleteAvatar(); set((s) => ({ me: user, users: { ...s.users, [user.id]: user } })) },
  setCurrentChannel: (currentChannelId) => set({ currentChannelId }),
  async loadMessages(id) {
    const prev = get().byChannel[id]; if (prev?.loading) return
    set((s) => ({ byChannel: { ...s.byChannel, [id]: { ...(prev ?? emptyMessages()), loading: true } } }))
    try { const res = await api.messages(id, undefined, PAGE); set((s) => ({ byChannel: { ...s.byChannel, [id]: { list: res.messages.sort((a, b) => cmpId(a.id, b.id)), loaded: true, loading: false, hasMore: res.messages.length >= PAGE } } })) }
    catch { set((s) => ({ byChannel: { ...s.byChannel, [id]: { ...(s.byChannel[id] ?? emptyMessages()), loading: false } } })) }
  },
  async loadOlder(id) {
    const cm = get().byChannel[id]; if (!cm || cm.loading || !cm.hasMore || !cm.list.length) return
    const oldestId = cm.list.reduce((oldest, m) => cmpId(m.id, oldest) < 0 ? m.id : oldest, cm.list[0].id)
    set((s) => ({ byChannel: { ...s.byChannel, [id]: { ...cm, loading: true } } }))
    try { const res = await api.messages(id, oldestId, PAGE); set((s) => { const cur = s.byChannel[id] ?? emptyMessages(); const ids = new Set(cur.list.map((m) => m.id)); const list = [...cur.list, ...res.messages.filter((m) => !ids.has(m.id))].sort((a, b) => cmpId(a.id, b.id)); return { byChannel: { ...s.byChannel, [id]: { ...cur, list, loading: false, hasMore: res.messages.length >= PAGE } } } }) }
    catch { set((s) => ({ byChannel: { ...s.byChannel, [id]: { ...(s.byChannel[id] ?? emptyMessages()), loading: false } } })) }
  },
  markRead(id, messageId) { set((s) => ({ channels: s.channels.map((c) => c.id === id ? { ...c, unread_count: 0 } : c) })); void api.markRead(id, messageId).catch(() => {}) },
  async sendMessage(channelId, content, parentId, attachmentIds, replyToId) {
    const tempId = `temp:${Date.now()}:${Math.random().toString(36).slice(2)}`
    const me = get().me
    if (!me) throw new Error('Not signed in')
    const quoted = replyToId ? get().replyTargets[channelId] : null
    const temp: Message = { id: tempId, channel_id: channelId, parent_id: parentId ?? null, user: me, content, created_at: new Date().toISOString(), edited_at: null, deleted_at: null, reactions: [], attachments: [], reply_count: 0, last_reply_at: null, reply_to: quoted ? { id: quoted.id, user: quoted.user, content: quoted.content.slice(0, 240), deleted: !!quoted.deleted_at } : null }
    set((s) => { const cm = s.byChannel[channelId]; return parentId ? { thread: s.thread.parentId === parentId ? { ...s.thread, replies: upsert(s.thread.replies, temp) } : s.thread } : { byChannel: cm?.loaded ? { ...s.byChannel, [channelId]: { ...cm, list: upsert(cm.list, temp) } } : s.byChannel } })
    try { const msg = await api.sendMessage(channelId, content, parentId, attachmentIds, replyToId); set((s) => { const cm = s.byChannel[channelId]; return { byChannel: cm ? { ...s.byChannel, [channelId]: { ...cm, list: cm.list.filter((m) => m.id !== tempId) } } : s.byChannel, thread: { ...s.thread, replies: s.thread.replies.filter((m) => m.id !== tempId) } } }); get().applyWsEvent({ type: 'message.created', payload: { message: msg } }); get().markRead(channelId, msg.id) }
    catch (e) { set((s) => { const cm = s.byChannel[channelId]; return { byChannel: cm ? { ...s.byChannel, [channelId]: { ...cm, list: cm.list.filter((m) => m.id !== tempId) } } : s.byChannel, thread: { ...s.thread, replies: s.thread.replies.filter((m) => m.id !== tempId) } } }); throw e }
  },
  async openDm(userId) { const ch = await api.createDm(userId); set((s) => ({ channels: s.channels.some((c) => c.id === ch.id) ? s.channels.map((c) => c.id === ch.id ? ch : c) : [...s.channels, ch] })); return ch },
  async loadMembers(id) { try { const r = await api.members(id); set((s) => ({ members: { ...s.members, [id]: r.members } })) } catch {} },
  async toggleReaction(message, emoji) { const mine = message.reactions.find((x) => x.emoji === emoji)?.me ?? false; const uid = get().me?.id ?? ''; applyReaction(set, uid, { message_id: message.id, channel_id: message.channel_id, emoji, user_id: uid }, !mine); try { mine ? await api.removeReaction(message.id, emoji) : await api.addReaction(message.id, emoji) } catch { applyReaction(set, uid, { message_id: message.id, channel_id: message.channel_id, emoji, user_id: uid }, mine); throw new Error('Could not update reaction') } },
  async editMessage(id, content) { const message = await api.editMessage(id, content); get().applyWsEvent({ type: 'message.updated', payload: { message } }) },
  async deleteMessage(id) { const all = [...Object.values(get().byChannel).flatMap((x) => x.list), get().thread.parent, ...get().thread.replies].filter(Boolean) as Message[]; const m = all.find((x) => x.id === id); await api.deleteMessage(id); if (m) get().applyWsEvent({ type: 'message.deleted', payload: { message_id: id, channel_id: m.channel_id, parent_id: m.parent_id } }) },
  async openThread(id) { set({ thread: { parentId: id, parent: null, replies: [], loading: true } }); try { const r = await api.thread(id); set((s) => s.thread.parentId === id ? { thread: { parentId: id, parent: r.parent, replies: r.replies.sort((a,b) => cmpId(a.id,b.id)), loading: false } } : {}) } catch { set({ thread: { parentId: null, parent: null, replies: [], loading: false } }); throw new Error('Could not load thread') } },
  closeThread: () => set({ thread: { parentId: null, parent: null, replies: [], loading: false } }),
  setDraft: (key, value) => set((s) => { const drafts = { ...s.drafts }; if (value) drafts[key] = value; else delete drafts[key]; return { drafts } }),
  setReplyTarget: (channelId, message) => set((s) => { const replyTargets = { ...s.replyTargets }; if (message) replyTargets[channelId] = message; else delete replyTargets[channelId]; return { replyTargets } }),
  requestComposerFocus: (key) => set((s) => ({ focusRequest: { key, n: (s.focusRequest?.n ?? 0) + 1 } })),
  sendTyping: (id) => get().ws?.sendTyping(id),
  async toggleMute(id) { const before = get().mutedChannels; const muted = !before.has(id); set((s) => { const next = new Set(s.mutedChannels); muted ? next.add(id) : next.delete(id); return { mutedChannels: next } }); try { await api.setChannelMute(id, muted) } catch { set({ mutedChannels: before }); throw new Error('Could not update channel notifications') } },
  pruneTyping() { const now = Date.now(); set((s) => { const typing: State['typing'] = {}; for (const [cid, entries] of Object.entries(s.typing)) { const keep = Object.fromEntries(Object.entries(entries).filter(([, e]) => e.expiresAt > now)); if (Object.keys(keep).length) typing[cid] = keep } return { typing } }) },
  totalUnread: () => get().channels.reduce((n, c) => n + c.unread_count, 0),
  applyWsEvent(env) {
    const me = get().me
    switch (env.type) {
      case 'hello': set({ online: new Set((env.payload as HelloPayload).online_user_ids) }); break
      case 'presence': { const p = env.payload as PresencePayload; set((s) => { const online = new Set(s.online); p.status === 'online' ? online.add(p.user_id) : online.delete(p.user_id); return { online } }); break }
      case 'typing': { const p = env.payload as TypingPayload; if (p.user_id !== me?.id) set((s) => ({ typing: { ...s.typing, [p.channel_id]: { ...(s.typing[p.channel_id] ?? {}), [p.user_id]: { display_name: p.display_name, expiresAt: Date.now() + 3000 } } } })); break }
      case 'message.created': applyCreated(set, env.payload as { message: Message }, me?.id ?? null); break
      case 'message.updated': applyUpdated(set, (env.payload as { message: Message }).message); break
      case 'message.deleted': applyDeleted(set, env.payload as { message_id: string; channel_id: string; parent_id: string | null }); break
      case 'reaction.added': case 'reaction.removed': applyReaction(set, get().me?.id ?? null, env.payload as ReactionPayload, env.type === 'reaction.added'); break
      case 'channel.created': { const { channel } = env.payload as { channel: Channel }; set((s) => ({ channels: s.channels.some((c) => c.id === channel.id) ? s.channels.map((c) => c.id === channel.id ? channel : c) : [...s.channels, channel] })); break }
      case 'channel.updated': { const { channel } = env.payload as { channel: Channel }; set((s) => ({ channels: s.channels.map((c) => c.id === channel.id ? { ...c, name: channel.name, topic: channel.topic, kind: channel.kind } : c) })); break }
      case 'channel.deleted': { const { channel_id } = env.payload as { channel_id: string }; set((s) => { const byChannel = { ...s.byChannel }, members = { ...s.members }; delete byChannel[channel_id]; delete members[channel_id]; return { channels: s.channels.filter((c) => c.id !== channel_id), byChannel, members, currentChannelId: s.currentChannelId === channel_id ? null : s.currentChannelId } }); break }
      case 'channel.member_joined': member(set, me?.id ?? null, env.payload as { channel_id: string; user: User }, true); break
      case 'channel.member_left': member(set, me?.id ?? null, env.payload as { channel_id: string; user: User }, false); break
      case 'user.updated': { const { user } = env.payload as { user: User }; set((s) => ({ users: { ...s.users, [user.id]: user }, me: s.me?.id === user.id ? user : s.me })); break }
      case 'notification.created': { const { notification } = env.payload as { notification: Notification }; const { dnd, currentChannelId } = get(); if (!dnd && notification.channel_id !== currentChannelId) void presentLocalNotification(notification).catch(() => {}); set((s) => { const exists = s.notifications.some((n) => n.id === notification.id); return { notifications: [notification, ...s.notifications.filter((n) => n.id !== notification.id)], notifUnread: !exists && !notification.read_at ? s.notifUnread + 1 : s.notifUnread } }); break }
    }
  },
}))

type Setter = (fn: (s: State) => Partial<State>) => void
const upsert = (list: Message[], message: Message) => [...list.filter((m) => m.id !== message.id), message].sort((a, b) => cmpId(a.id, b.id))
function applyCreated(set: Setter, { message }: { message: Message }, myId: string | null) { set((s) => { const cm = s.byChannel[message.channel_id]; const thread = s.thread; if (message.parent_id) { const byChannel = cm ? { ...s.byChannel, [message.channel_id]: { ...cm, list: cm.list.map((m) => m.id === message.parent_id ? { ...m, reply_count: m.reply_count + 1, last_reply_at: message.created_at } : m) } } : s.byChannel; return { byChannel, thread: thread.parentId === message.parent_id ? { ...thread, replies: upsert(thread.replies, message) } : thread } } const byChannel = cm?.loaded ? { ...s.byChannel, [message.channel_id]: { ...cm, list: upsert(cm.list, message) } } : s.byChannel; return { byChannel, channels: s.channels.map((c) => c.id === message.channel_id ? { ...c, last_message_at: message.created_at, unread_count: s.currentChannelId !== c.id && message.user.id !== myId ? c.unread_count + 1 : c.unread_count } : c) } }) }
function applyUpdated(set: Setter, message: Message) { set((s) => { const merge = (m: Message) => m.id === message.id ? { ...m, ...message } : m; const cm = s.byChannel[message.channel_id]; return { byChannel: cm ? { ...s.byChannel, [message.channel_id]: { ...cm, list: cm.list.map(merge) } } : s.byChannel, thread: { ...s.thread, parent: s.thread.parent ? merge(s.thread.parent) : null, replies: s.thread.replies.map(merge) } } }) }
function applyDeleted(set: Setter, p: { message_id: string; channel_id: string; parent_id: string | null }) { set((s) => { const cm = s.byChannel[p.channel_id]; const del = (m: Message) => p.parent_id && m.id === p.parent_id ? { ...m, reply_count: Math.max(0, m.reply_count - 1) } : m.id === p.message_id ? { ...m, content: '', deleted_at: new Date().toISOString() } : m; return { byChannel: cm ? { ...s.byChannel, [p.channel_id]: { ...cm, list: cm.list.map(del) } } : s.byChannel, thread: { ...s.thread, parent: s.thread.parent ? del(s.thread.parent) : null, replies: s.thread.replies.map(del) } } }) }
function applyReaction(set: Setter, myId: string | null, p: ReactionPayload, add: boolean) { set((s) => { const change = (m: Message) => m.id !== p.message_id ? m : { ...m, reactions: reaction(m.reactions, p.emoji, add, p.user_id === myId) }; const cm = s.byChannel[p.channel_id]; return { byChannel: cm ? { ...s.byChannel, [p.channel_id]: { ...cm, list: cm.list.map(change) } } : s.byChannel, thread: { ...s.thread, parent: s.thread.parent ? change(s.thread.parent) : null, replies: s.thread.replies.map(change) } } }) }
function reaction(rs: Message['reactions'], emoji: string, add: boolean, me: boolean) { const i = rs.findIndex((r) => r.emoji === emoji); if (add) { if (i < 0) return [...rs, { emoji, count: 1, me }]; const n = [...rs]; n[i] = { ...n[i], count: n[i].count + 1, me: n[i].me || me }; return n } if (i < 0) return rs; const n = [...rs]; if (n[i].count === 1) return n.filter((_, x) => x !== i); n[i] = { ...n[i], count: n[i].count - 1, me: me ? false : n[i].me }; return n }
function member(set: Setter, meId: string | null, p: { channel_id: string; user: User }, joined: boolean) { set((s) => { const cached = s.members[p.channel_id]; return { users: { ...s.users, [p.user.id]: p.user }, channels: p.user.id === meId ? s.channels.map((c) => c.id === p.channel_id ? { ...c, is_member: joined } : c) : s.channels, members: cached ? { ...s.members, [p.channel_id]: joined ? (cached.some((u) => u.id === p.user.id) ? cached : [...cached, p.user]) : cached.filter((u) => u.id !== p.user.id) } : s.members } }) }

setInterval(() => useStore.getState().pruneTyping(), 1000)
