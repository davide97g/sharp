// Message reducers: reactions, ordered insertion, decryption, and the three
// message.* WS events.
//
// Contract: docs/arch/01-core.md ("Wire types", the message.* events).
//
// Guardrail: message ids are bigints serialized as strings. Order them with `cmpId`,
// never with `<` or by casting to Number — past 2^53 the comparison silently lies.
//
// Guardrail: E2EE DM plaintext must never reach the server or a persisted store field.
// `decryptIncoming` attaches `decryptedText` in memory only, and `queueDecryptions`
// deliberately runs after the message is already in the list, so an undecryptable
// message still renders (as a locked placeholder) instead of vanishing.
//
// `MAX_CACHED_MESSAGES` trims each channel's list on insert; the full history is always
// one fetch away, and an unbounded list is what makes a long-lived tab slow.

import { cmpId } from '../util'
import { decryptDmMessage } from '../e2ee'
import { resolveEncryptedAttachments } from '../e2ee/attachments'
import { indexDecryptedMessage } from '../e2ee/search'
import type { ChannelMessages, State } from '../../store'
import type { Message } from '../types'

export type Setter = (
  partial:
    | Partial<State>
    | ((s: State) => Partial<State> | State),
) => void

export function updateReactions(
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

export function upsertAscending(list: Message[], msg: Message): Message[] {
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

export function findMessage(state: State, messageId: string): Message | null {
  for (const channel of Object.values(state.byChannel)) {
    const message = channel.list.find((item) => item.id === messageId)
    if (message) return message
  }
  if (state.thread.parent?.id === messageId) return state.thread.parent
  return state.thread.replies.find((item) => item.id === messageId) ?? null
}

export async function decryptIncoming(message: Message): Promise<Message> {
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

export function patchDecryptedMessages(set: Setter, decrypted: Message[]): void {
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

export function queueDecryptions(set: Setter, messages: Message[]): void {
  const pending = messages.filter(
    (message) => message.encrypted && !message.deleted_at && message.decryptedText === undefined,
  )
  if (!pending.length) return
  void Promise.all(pending.map(decryptIncoming)).then((decrypted) =>
    patchDecryptedMessages(set, decrypted),
  )
}

export function applyDuckStreak(
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

export function applyMessageCreated(
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

export function applyMessageUpdated(set: Setter, message: Message) {
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

export function applyMessageDeleted(
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
