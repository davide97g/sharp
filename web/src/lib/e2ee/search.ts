import { idbDelete, idbGetAll, idbPut } from './idb'
import type { SearchResult } from '../types'

export type LocalSearchMessage = {
  id: string
  channelId: string
  text: string
  authorName: string
  ts: string
}

export async function indexDecryptedMessage(message: LocalSearchMessage): Promise<void> {
  await idbPut('messages', message.id, message)
}

export async function removeIndexedMessage(id: string): Promise<void> {
  await idbDelete('messages', id)
}

export async function searchLocal(q: string, limit = 20): Promise<LocalSearchMessage[]> {
  const terms = q.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length || limit <= 0) return []
  const rows = await idbGetAll<LocalSearchMessage>('messages')
  return rows
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 20_000)
    .filter((row) => {
      const haystack = `${row.text}\n${row.authorName}`.toLocaleLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .slice(0, limit)
}

export function localSearchResult(
  row: LocalSearchMessage,
  channelName: string,
): SearchResult {
  return {
    id: row.id,
    channel_id: row.channelId,
    parent_id: null,
    user: { id: `local:${row.authorName}`, display_name: row.authorName, avatar_url: null },
    content: row.text,
    encrypted: true,
    decryptedText: row.text,
    created_at: row.ts,
    edited_at: null,
    deleted_at: null,
    reactions: [],
    attachments: [],
    reply_count: 0,
    last_reply_at: null,
    reply_to: null,
    channel_name: channelName,
    snippet: row.text,
    local: true,
  }
}
